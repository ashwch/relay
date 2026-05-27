import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PluginLoadError } from './errors.js';

/**
 * Git-backed external plugin support.
 *
 * First-principles goal:
 *
 *   plugin config should be able to answer
 *   "where does this plugin live?"
 *
 * with one explicit ref, without asking CI to clone a second repo by hand.
 *
 * Visual model:
 *
 *   git:github.com/owner/repo//plugin-subdir@main
 *      ↓
 *   parse ref into host + repo + optional subdir + optional git ref
 *      ↓
 *   clone/fetch into a deterministic local cache
 *      ↓
 *   resolve one plugin root directory
 *      ↓
 *   let the normal manifest loader take over
 *
 * Why a cache instead of cloning into the workspace?
 *
 * - keeps plugin loading explicit and isolated
 * - avoids mutating the caller's repo checkout
 * - gives local development a stable reuse path
 * - keeps the rest of the loader logic small
 *
 * Why keep this file synchronous?
 *
 * The existing plugin resolution pipeline is synchronous today.
 * A small synchronous clone/fetch step keeps the integration narrow and avoids
 * refactoring the rest of plugin loading into async code.
 */

/**
 * One parsed git plugin ref after syntax-only validation.
 *
 * Important boundary:
 * this object describes intent only.
 * Parsing does not touch the network or disk.
 */
export interface GitPluginRef {
  ref: string;
  host: string;
  repoPath: string;
  subdir: string;
  gitRef: string;
  cloneUrl: string;
  cacheDir: string;
}

const gitPrefix = 'git:';

/**
 * Parse a git plugin ref without doing any I/O.
 *
 * Accepted shape:
 *
 *   git:<host>/<owner-or-group>/<repo>//<optional/subdir>@<optional-ref>
 *
 * Examples:
 *
 *   git:github.com/acme/relay-plugins//slack-notify@main
 *   git:github.com/acme/relay-plugins//slack-notify@v1.2.3
 *   git:github.com/acme/relay-plugins//slack-notify@9f3c1d2
 *   git:github.com/acme/relay-plugins
 *
 * Parsing rules are intentionally simple and stable:
 *
 *   last @  -> git ref separator
 *   first / -> host separator
 *   //      -> plugin subdir separator
 *
 * Why split on the last @?
 * Because subdirectories can legitimately contain @ in their names, while the
 * final @ is the only place where Relay treats the rest as the git ref.
 */
export function parseGitPluginRef(ref: string): GitPluginRef {
  if (!ref.startsWith(gitPrefix)) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: must start with git:`);
  }

  const rawRef = ref.slice(gitPrefix.length);
  if (rawRef.length === 0) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: missing host and repository`);
  }

  const lastAtIndex = rawRef.lastIndexOf('@');
  const repoAndSubdir = lastAtIndex === -1 ? rawRef : rawRef.slice(0, lastAtIndex);
  const gitRef = lastAtIndex === -1 ? '' : rawRef.slice(lastAtIndex + 1);

  if (repoAndSubdir.length === 0) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: missing host and repository`);
  }
  if (lastAtIndex !== -1 && gitRef.length === 0) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: empty git ref after @`);
  }

  const subdirSeparatorIndex = repoAndSubdir.indexOf('//');
  const repoAndHost = subdirSeparatorIndex === -1 ? repoAndSubdir : repoAndSubdir.slice(0, subdirSeparatorIndex);
  const subdir = subdirSeparatorIndex === -1 ? '' : repoAndSubdir.slice(subdirSeparatorIndex + 2);

  if (subdirSeparatorIndex !== -1 && subdir.length === 0) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: empty plugin subdir after //`);
  }
  assertSafeRelativePath(ref, 'plugin subdir', subdir);

  const firstSlashIndex = repoAndHost.indexOf('/');
  if (firstSlashIndex === -1) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: missing repository path`);
  }

  const host = repoAndHost.slice(0, firstSlashIndex);
  const repoPath = repoAndHost.slice(firstSlashIndex + 1);

  if (host.length === 0) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: missing git host`);
  }
  if (repoPath.length === 0) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: missing repository path`);
  }
  if (repoPath.startsWith('/') || repoPath.endsWith('/')) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: repository path must not start or end with /`);
  }
  if (!isValidGitHost(host)) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: invalid git host ${host}`);
  }
  assertSafeRelativePath(ref, 'repository path', repoPath);

  const parsed: GitPluginRef = {
    ref,
    host,
    repoPath,
    subdir,
    gitRef,
    cloneUrl: `https://${host}/${repoPath}.git`,
    cacheDir: '',
  };

  parsed.cacheDir = getGitCacheDir(parsed);
  return parsed;
}

/**
 * Compute the deterministic cache directory for one parsed ref.
 *
 * Visual model:
 *
 *   cache root
 *     ↓
 *   <host>/<repoPath>
 *     ↓
 *   repo | ref-<hash>
 *
 * Unpinned refs use `repo`.
 * Pinned refs use a ref-derived hash segment.
 *
 * Why include the git ref in the cache key?
 * Because a checkout for `@main` and a checkout for `@v1.2.3` must not mutate
 * the same working tree underneath two different Relay runs.
 */
export function getGitCacheDir(parsed: GitPluginRef): string {
  return path.resolve(getGitCacheRoot(), parsed.host, parsed.repoPath, getRepositoryCacheLeafName(parsed.gitRef));
}

/**
 * Ensure the repository for a git plugin ref exists locally and return the
 * final plugin root directory.
 *
 * Visual flow:
 *
 *   parsed ref
 *     ↓
 *   clone repo if missing or broken
 *     ↓
 *   if cloning is needed, clone into a unique temp sibling first
 *     ↓
 *   rename temp clone into the final cache path
 *     ↓
 *   fetch + checkout requested ref if one was provided
 *     ↓
 *   resolve optional plugin subdir
 *     ↓
 *   install plugin-local runtime dependencies when package.json exists
 *
 * Why use a temp clone + rename step?
 * Because the final cache path should mean "ready to use" as much as possible.
 * A failed or concurrent clone should not leave behind a misleading half-clone
 * that future runs mistake for a healthy repository.
 *
 * Why install dependencies inside the plugin root?
 * Because external plugins run from their own directory. Relay should not rely
 * on the caller's repo-level node_modules to satisfy a plugin's runtime needs.
 *
 * Security rule:
 * plugin dependency installation should not inherit the full Relay process
 * environment. The runtime later executes plugins with a minimal request-driven
 * contract, so install-time subprocesses should also avoid ambient CI secrets.
 */
export function ensureGitPlugin(parsed: GitPluginRef): string {
  fs.mkdirSync(path.dirname(parsed.cacheDir), { recursive: true });

  if (!hasClonedRepository(parsed.cacheDir)) {
    cloneRepositoryIntoCache(parsed);

    if (parsed.gitRef) {
      checkoutGitRef(parsed);
    }
  } else if (parsed.gitRef) {
    checkoutGitRef(parsed);
  }

  const rootDir = parsed.subdir
    ? path.resolve(parsed.cacheDir, parsed.subdir)
    : parsed.cacheDir;

  if (!isPathInside(parsed.cacheDir, rootDir)) {
    throw new PluginLoadError(`git plugin ${parsed.ref}: resolved plugin root escapes the git cache`);
  }

  if (fs.existsSync(path.resolve(rootDir, 'package.json'))) {
    runNpmCommand(parsed, ['install', '--omit=dev', '--ignore-scripts'], `install plugin dependencies in ${rootDir}`, rootDir);
  }

  return rootDir;
}

/**
 * Move an existing cached clone to the requested git ref.
 *
 * Why not `git clone --branch <ref>`?
 * Because branches and tags work there, but raw commit SHAs do not.
 * The clone + fetch + checkout sequence handles branches, tags, and SHAs with
 * one consistent code path.
 */
function checkoutGitRef(parsed: GitPluginRef): void {
  runGitCommand(parsed, ['-C', parsed.cacheDir, 'fetch', '--depth', '1', 'origin', parsed.gitRef], `fetch ref ${parsed.gitRef}`);
  runGitCommand(parsed, ['-C', parsed.cacheDir, 'checkout', 'FETCH_HEAD'], `checkout ref ${parsed.gitRef}`);
}

/**
 * Clone a repository into the cache using a temporary directory first.
 *
 * Why not clone directly into `cacheDir`?
 * Because failed or concurrent clone attempts can otherwise leave behind a
 * half-populated target directory. Cloning into a unique temp directory keeps
 * the final cache location cleaner and makes "another process won the race"
 * easier to recognize safely.
 */
function cloneRepositoryIntoCache(parsed: GitPluginRef): void {
  // Recheck the final cache path right before destructive cleanup.
  // Another Relay process may have populated a valid clone after our caller's
  // earlier hasClonedRepository(...) check but before we reached this point.
  if (hasClonedRepository(parsed.cacheDir)) {
    return;
  }

  fs.rmSync(parsed.cacheDir, { recursive: true, force: true });

  const tempCloneDir = createTemporaryCloneDir(parsed.cacheDir);
  try {
    runGitCommand(parsed, ['clone', '--depth', '1', parsed.cloneUrl, tempCloneDir], `clone ${parsed.cloneUrl}`);
    moveClonedRepositoryIntoCache(parsed, tempCloneDir);
  } catch (error) {
    fs.rmSync(tempCloneDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Choose the root directory for the git plugin cache.
 *
 * Precedence order:
 *
 *   1. RELAY_GIT_CACHE_DIR
 *   2. RUNNER_TEMP/relay-git-cache
 *   3. TMPDIR|TEMP|TMP + /relay-git-cache
 *   4. ~/.relay/cache/git
 *
 * Why prefer runner/temp directories in CI?
 * Because they are expected to be disposable. That keeps CI behavior simple:
 * each run can start from a clean cache without us inventing long-lived cache
 * invalidation rules.
 */
function getGitCacheRoot(): string {
  if (process.env.RELAY_GIT_CACHE_DIR) {
    return path.resolve(process.env.RELAY_GIT_CACHE_DIR);
  }
  if (process.env.RUNNER_TEMP) {
    return path.resolve(process.env.RUNNER_TEMP, 'relay-git-cache');
  }

  const tempRoot = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  if (tempRoot) {
    return path.resolve(tempRoot, 'relay-git-cache');
  }

  return path.resolve(os.homedir(), '.relay', 'cache', 'git');
}

/**
 * Treat a cache directory as valid only when it looks like a real git clone.
 *
 * Why be strict?
 * A previous interrupted clone can leave behind a half-populated directory.
 * Recloning that directory is safer than assuming it is usable.
 */
function hasClonedRepository(cacheDir: string): boolean {
  return fs.existsSync(cacheDir) && fs.existsSync(path.resolve(cacheDir, '.git'));
}

/**
 * Build a unique sibling directory for an in-progress clone.
 *
 * Keeping temporary clones next to the final cache path makes the later rename
 * cheap and keeps cleanup localized to one cache root.
 */
function createTemporaryCloneDir(cacheDir: string): string {
  const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${cacheDir}.tmp-${uniqueSuffix}`;
}

/**
 * Promote a successfully cloned temporary directory into the final cache path.
 *
 * If another process won the race and already created a valid cache, we accept
 * that result and reuse it instead of failing.
 *
 * Visual model:
 *
 *   process A: clone temp-A ─┐
 *                            ├─> one rename wins
 *   process B: clone temp-B ─┘
 *
 * loser sees a valid cache already exists
 *   -> temp clone is discarded
 *   -> shared cache is reused
 */
function moveClonedRepositoryIntoCache(parsed: GitPluginRef, tempCloneDir: string): void {
  try {
    fs.renameSync(tempCloneDir, parsed.cacheDir);
  } catch (error) {
    fs.rmSync(tempCloneDir, { recursive: true, force: true });
    if (hasClonedRepository(parsed.cacheDir)) {
      return;
    }
    throw new PluginLoadError(`git plugin ${parsed.ref} failed to move cloned repository into cache: ${extractFileSystemFailure(error)}`);
  }
}

/**
 * Run one git command and rethrow failures as PluginLoadError.
 *
 * Small design rule:
 * keep the try/catch boundary around exactly one subprocess call so readers can
 * see which operation failed and why.
 */
function runGitCommand(parsed: GitPluginRef, args: string[], action: string): void {
  try {
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new PluginLoadError(`git plugin ${parsed.ref} failed to ${action}: ${extractCommandFailure(error)}`);
  }
}

/**
 * Run one npm command inside the resolved plugin root.
 *
 * Today the install strategy is intentionally minimal:
 *
 *   npm install --omit=dev --ignore-scripts
 *
 * Why `--ignore-scripts`?
 * Because install-time lifecycle scripts would run before Relay applies its
 * normal minimal plugin execution environment, which could leak unrelated CI
 * secrets into plugin setup.
 */
function runNpmCommand(parsed: GitPluginRef, args: string[], action: string, cwd: string): void {
  try {
    execFileSync('npm', args, {
      cwd,
      encoding: 'utf8',
      env: getSafeInstallEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new PluginLoadError(`git plugin ${parsed.ref} failed to ${action}: ${extractCommandFailure(error)}`);
  }
}

/**
 * Pull the most useful human-readable failure text out of a subprocess error.
 *
 * Priority order:
 *
 *   stderr -> stdout -> generic message
 *
 * Why prefer stderr first?
 * Because git and npm normally explain actionable failures there.
 */
function extractCommandFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const stderr = 'stderr' in error ? error.stderr : undefined;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr) && stderr.length > 0) {
      return stderr.toString('utf8').trim();
    }

    const stdout = 'stdout' in error ? error.stdout : undefined;
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      return stdout.trim();
    }
    if (Buffer.isBuffer(stdout) && stdout.length > 0) {
      return stdout.toString('utf8').trim();
    }
  }

  return extractFileSystemFailure(error);
}

/**
 * Pull the most useful message out of a non-subprocess filesystem error.
 */
function extractFileSystemFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return 'command failed';
}

function isValidGitHost(host: string): boolean {
  return /^(?!\.{1,2}$)[A-Za-z0-9.-]+(?::\d+)?$/.test(host);
}

function getRepositoryCacheLeafName(gitRef: string): string {
  if (gitRef.length === 0) {
    return 'repo';
  }
  return `ref-${createHash('sha256').update(gitRef).digest('hex').slice(0, 12)}`;
}

function getSafeInstallEnvironment(): NodeJS.ProcessEnv {
  return compactEnvironment({
    CI: process.env.CI,
    COMSPEC: process.env.COMSPEC,
    HOME: process.env.HOME,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    USERPROFILE: process.env.USERPROFILE,
    npm_config_cache: process.env.npm_config_cache,
    npm_config_userconfig: process.env.npm_config_userconfig,
  });
}

function compactEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/**
 * Reject path shapes that are ambiguous or unsafe for cache resolution.
 *
 * We allow nested paths such as `plugins/notify`, but reject:
 *
 * - empty path segments
 * - `.` segments
 * - `..` segments
 * - backslash separators
 *
 * Why?
 * The git ref syntax should describe a location inside one repo, not provide a
 * way to escape the cache root or depend on platform-specific path quirks.
 */
function assertSafeRelativePath(ref: string, label: string, value: string): void {
  if (value.length === 0) {
    return;
  }
  if (value.includes('\\')) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: ${label} must use / separators`);
  }
  if (value.startsWith('/') || value.endsWith('/')) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: ${label} must not start or end with /`);
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new PluginLoadError(`invalid git plugin ref ${ref}: ${label} must not contain empty, ., or .. path segments`);
  }
}

/**
 * Check that a resolved plugin root stays inside the cloned repository cache.
 *
 * First principle:
 * a git plugin ref may narrow from repo root to a subdirectory,
 * but it must never escape upward out of that repository.
 */
function isPathInside(parentDir: string, candidateDir: string): boolean {
  const absoluteParentDir = path.resolve(parentDir);
  const absoluteCandidateDir = path.resolve(candidateDir);
  if (absoluteCandidateDir === absoluteParentDir) {
    return true;
  }

  const relativePath = path.relative(absoluteParentDir, absoluteCandidateDir);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}
