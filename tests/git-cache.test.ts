import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

import { PluginLoadError } from '../src/core/plugins/errors.js';
import { ensureGitPlugin, getGitCacheDir, parseGitPluginRef } from '../src/core/plugins/git-cache.js';

const pinnedPluginRef = 'git:github.com/ashwch/relay-plugins//monolith-notify@main';
const unpinnedPluginRef = 'git:github.com/ashwch/relay-plugins//monolith-notify';
const repoOnlyPluginRef = 'git:github.com/ashwch/relay-plugins';
const originalEnv = { ...process.env };
const tempDirs: string[] = [];

describe('git plugin cache', () => {
  afterEach(() => {
    vi.mocked(execFileSync as typeof ChildProcess.execFileSync).mockReset();
    process.env = { ...originalEnv };
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('parses git plugin refs with host, repo, subdir, and ref', () => {
    const parsed = parseGitPluginRef(pinnedPluginRef);

    expect(parsed).toMatchObject({
      ref: pinnedPluginRef,
      host: 'github.com',
      repoPath: 'ashwch/relay-plugins',
      subdir: 'monolith-notify',
      gitRef: 'main',
      cloneUrl: 'https://github.com/ashwch/relay-plugins.git',
    });
    expect(parsed.cacheDir).toBe(getGitCacheDir(parsed));
    expect(parsed.cacheDir).toContain(path.join('github.com', 'ashwch', 'relay-plugins', 'ref-'));
  });

  it('uses separate cache directories for different pinned refs from the same repo', () => {
    const mainRef = parseGitPluginRef(repoOnlyPluginRef + '@main');
    const tagRef = parseGitPluginRef(repoOnlyPluginRef + '@v1.2.3');
    const unpinnedRef = parseGitPluginRef(repoOnlyPluginRef);

    expect(mainRef.cacheDir).not.toBe(tagRef.cacheDir);
    expect(mainRef.cacheDir).not.toBe(unpinnedRef.cacheDir);
    expect(unpinnedRef.cacheDir).toMatch(new RegExp(`${escapeForRegExp(path.join('ashwch', 'relay-plugins', 'repo'))}$`));
  });

  it('parses edge-case git plugin refs', () => {
    expect(parseGitPluginRef('git:github.com/a/b@v1').subdir).toBe('');
    expect(parseGitPluginRef('git:github.com/a/b').gitRef).toBe('');
    expect(parseGitPluginRef('git:github.com/a/b//c/d@main').subdir).toBe('c/d');
    expect(parseGitPluginRef('git:github.com/a/b//sub@name@main').subdir).toBe('sub@name');
  });

  it('resolves cache root precedence from RELAY_GIT_CACHE_DIR', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;
    process.env.RUNNER_TEMP = createTempDir('relay-runner-temp-');

    const parsed = parseGitPluginRef('git:github.com/example/repo');

    expect(parsed.cacheDir).toBe(path.resolve(cacheRoot, 'github.com', 'example/repo', 'repo'));
  });

  it('clones, checks out a pinned ref, and installs dependencies', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(pinnedPluginRef);
    const execFileSyncMock = vi.mocked(execFileSync as typeof ChildProcess.execFileSync);
    execFileSyncMock.mockImplementation((file: string, args?: readonly string[]) => {
      if (file === 'git' && Array.isArray(args) && args[0] === 'clone') {
        const cloneTarget = String(args.at(-1));
        fs.mkdirSync(path.join(cloneTarget, '.git'), { recursive: true });
        fs.mkdirSync(path.join(cloneTarget, 'monolith-notify'), { recursive: true });
        fs.writeFileSync(path.join(cloneTarget, 'monolith-notify', 'package.json'), '{"name":"monolith-notify"}\n', 'utf8');
      }
      return '';
    });

    const expectedCloneTarget = expect.stringMatching(new RegExp(`^${escapeForRegExp(parsed.cacheDir)}\\.tmp-`));

    const rootDir = ensureGitPlugin(parsed);

    expect(rootDir).toBe(fs.realpathSync(path.join(parsed.cacheDir, 'monolith-notify')));
    expect(execFileSyncMock.mock.calls).toEqual([
      ['git', ['clone', '--depth', '1', parsed.cloneUrl, expectedCloneTarget], expect.any(Object)],
      ['git', ['-C', parsed.cacheDir, 'fetch', '--depth', '1', 'origin', 'main'], expect.any(Object)],
      ['git', ['-C', parsed.cacheDir, 'checkout', 'FETCH_HEAD'], expect.any(Object)],
      ['npm', ['install', '--omit=dev', '--ignore-scripts', '--package-lock=false'], expect.objectContaining({ cwd: rootDir, env: expect.any(Object) })],
    ]);
    expect(execFileSyncMock.mock.calls.at(-1)?.[2]).toMatchObject({
      env: expect.not.objectContaining({
        TOP_SECRET: expect.anything(),
      }),
    });
  });

  it('reuses an unpinned cache hit without fetching', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(unpinnedPluginRef);
    const rootDir = path.join(parsed.cacheDir, 'monolith-notify');
    fs.mkdirSync(path.join(parsed.cacheDir, '.git'), { recursive: true });
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'package.json'), '{"name":"monolith-notify"}\n', 'utf8');

    const originalTopSecret = process.env.TOP_SECRET;
    process.env.TOP_SECRET = 'do-not-forward';

    const execFileSyncMock = vi.mocked(execFileSync as typeof ChildProcess.execFileSync);
    execFileSyncMock.mockReturnValue('');

    try {
      expect(ensureGitPlugin(parsed)).toBe(fs.realpathSync(rootDir));
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'npm',
        ['install', '--omit=dev', '--ignore-scripts', '--package-lock=false'],
        expect.objectContaining({
          cwd: fs.realpathSync(rootDir),
          env: expect.not.objectContaining({ TOP_SECRET: 'do-not-forward' }),
        }),
      );
    } finally {
      if (originalTopSecret === undefined) {
        delete process.env.TOP_SECRET;
      } else {
        process.env.TOP_SECRET = originalTopSecret;
      }
    }
  });

  it('uses npm ci when a lockfile exists', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(unpinnedPluginRef);
    const rootDir = path.join(parsed.cacheDir, 'monolith-notify');
    fs.mkdirSync(path.join(parsed.cacheDir, '.git'), { recursive: true });
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'package.json'), '{"name":"monolith-notify"}\n', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'package-lock.json'), '{"name":"monolith-notify","lockfileVersion":3}\n', 'utf8');

    const execFileSyncMock = vi.mocked(execFileSync as typeof ChildProcess.execFileSync);
    execFileSyncMock.mockReturnValue('');

    expect(ensureGitPlugin(parsed)).toBe(fs.realpathSync(rootDir));
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'npm',
      ['ci', '--omit=dev', '--ignore-scripts'],
      expect.objectContaining({ cwd: fs.realpathSync(rootDir) }),
    );
  });

  it('rejects symlinked plugin roots that escape the cache', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(unpinnedPluginRef);
    const escapedRoot = createTempDir('relay-plugin-escaped-root-');
    const pluginRoot = path.join(parsed.cacheDir, 'monolith-notify');
    fs.mkdirSync(path.join(parsed.cacheDir, '.git'), { recursive: true });
    fs.mkdirSync(escapedRoot, { recursive: true });
    fs.writeFileSync(path.join(escapedRoot, 'package.json'), '{"name":"escaped-plugin"}\n', 'utf8');
    fs.symlinkSync(escapedRoot, pluginRoot, 'dir');

    expect(() => ensureGitPlugin(parsed)).toThrowError('resolved plugin root escapes the git cache');
  });

  it('reclones a broken cache directory before use', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(repoOnlyPluginRef);
    fs.mkdirSync(parsed.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(parsed.cacheDir, 'partial.txt'), 'broken clone\n', 'utf8');

    const execFileSyncMock = vi.mocked(execFileSync as typeof ChildProcess.execFileSync);
    execFileSyncMock.mockImplementation((file: string, args?: readonly string[]) => {
      if (file === 'git' && Array.isArray(args) && args[0] === 'clone') {
        const cloneTarget = String(args.at(-1));
        fs.mkdirSync(path.join(cloneTarget, '.git'), { recursive: true });
      }
      return '';
    });

    expect(ensureGitPlugin(parsed)).toBe(fs.realpathSync(parsed.cacheDir));
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth', '1', parsed.cloneUrl, expect.stringMatching(new RegExp(`^${escapeForRegExp(parsed.cacheDir)}\\.tmp-`))],
      expect.any(Object),
    );
    expect(fs.existsSync(path.join(parsed.cacheDir, 'partial.txt'))).toBe(false);
  });

  it('reuses a cache that appears after the initial existence check but before cleanup', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(repoOnlyPluginRef);
    fs.mkdirSync(parsed.cacheDir, { recursive: true });

    const originalExistsSync = fs.existsSync.bind(fs);
    const existsSyncSpy = vi.spyOn(fs, 'existsSync');
    let gitDirChecks = 0;
    existsSyncSpy.mockImplementation((targetPath) => {
      const normalizedTargetPath = path.resolve(String(targetPath));
      if (normalizedTargetPath === path.resolve(parsed.cacheDir, '.git')) {
        gitDirChecks += 1;
        if (gitDirChecks === 2) {
          fs.mkdirSync(path.join(parsed.cacheDir, '.git'), { recursive: true });
        }
      }
      return originalExistsSync(targetPath);
    });

    const execFileSyncMock = vi.mocked(execFileSync as typeof ChildProcess.execFileSync);
    execFileSyncMock.mockReturnValue('');

    try {
      expect(ensureGitPlugin(parsed)).toBe(fs.realpathSync(parsed.cacheDir));
      expect(execFileSyncMock).not.toHaveBeenCalled();
    } finally {
      existsSyncSpy.mockRestore();
    }
  });

  // Protect the "two Relay processes start from a cold cache at the same time"
  // case. We do not want the second process to fail just because the first one
  // finished cloning a moment earlier.
  it('accepts a clone race when another process populates the cache first', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(repoOnlyPluginRef);
    const execFileSyncMock = vi.mocked(execFileSync as typeof ChildProcess.execFileSync);
    execFileSyncMock.mockImplementation((file: string, args?: readonly string[]) => {
      if (file === 'git' && Array.isArray(args) && args[0] === 'clone') {
        const cloneTarget = String(args.at(-1));
        fs.mkdirSync(path.join(cloneTarget, '.git'), { recursive: true });
        fs.mkdirSync(path.join(parsed.cacheDir, '.git'), { recursive: true });
      }
      return '';
    });

    expect(ensureGitPlugin(parsed)).toBe(fs.realpathSync(parsed.cacheDir));
    expect(fs.existsSync(path.join(parsed.cacheDir, '.git'))).toBe(true);
  });

  it('surfaces invalid ref formats clearly', () => {
    expect(() => parseGitPluginRef('git:github.com')).toThrowError('missing repository path');
    expect(() => parseGitPluginRef('git:github.com/example/repo@')).toThrowError('empty git ref after @');
    expect(() => parseGitPluginRef('git:github.com/example/repo//')).toThrowError('empty plugin subdir after //');
    expect(() => parseGitPluginRef('git:../example/repo')).toThrowError('invalid git host');
    expect(() => parseGitPluginRef('git:./example/repo')).toThrowError('invalid git host');
  });

  it('rejects repository and subdir path traversal', () => {
    expect(() => parseGitPluginRef('git:github.com/example/../repo')).toThrowError('repository path must not contain empty, ., or .. path segments');
    expect(() => parseGitPluginRef('git:github.com/example/repo//../plugin')).toThrowError('plugin subdir must not contain empty, ., or .. path segments');
  });

  it('wraps git command failures in PluginLoadError with stderr', () => {
    const cacheRoot = createTempDir('relay-git-cache-root-');
    process.env.RELAY_GIT_CACHE_DIR = cacheRoot;

    const parsed = parseGitPluginRef(repoOnlyPluginRef + '@main');
    vi.mocked(execFileSync as typeof ChildProcess.execFileSync).mockImplementation(() => {
      throw {
        stderr: Buffer.from('fatal: repository not found\n'),
      };
    });

    expect(() => ensureGitPlugin(parsed)).toThrowError(PluginLoadError);
    expect(() => ensureGitPlugin(parsed)).toThrowError('fatal: repository not found');
  });
});

function createTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
