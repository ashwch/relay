import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeReleaseDocument } from '../src/core/orchestration/finalize-run.js';
import type { NormalizedRelease } from '../src/core/release-json/schema.js';
import type { RuntimeArgs, StringMap } from '../src/core/types/runtime.js';

/**
 * Versioning tests document one critical framework promise:
 * projects can choose different release version schemas without changing core.
 */
const fixedNow = new Date('2026-05-22T19:13:02.000Z');
const sha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c';
const repository = 'ExampleOrg/example-service';
const fixtureWorkspaceRoot = path.resolve(import.meta.dirname, '..');
const tempDirs: string[] = [];

interface GitHubTagListEntry {
  name: string;
  commit: {
    sha: string;
  };
}

const fixtures = {
  dateTime: fixturePath('version-date-time.yml'),
  dateCounterExplicit: fixturePath('version-date-counter-explicit.yml'),
  backendFirst: fixturePath('version-backend-date-release-explicit-first.yml'),
  backendThird: fixturePath('version-backend-date-release-explicit-third.yml'),
  templateExplicit: fixturePath('version-template-explicit.yml'),
  backendAuto: fixturePath('version-backend-date-release-auto.yml'),
  filePackageJson: fixturePath('version-package-json.yml'),
  env: fixturePath('version-env.yml'),
  gitTag: fixturePath('version-git-tag.yml'),
};

// The runtime data fixtures stay on disk because the file source must read
// real JSON/YAML/TOML content.
//
// The config fixtures do not need to stay on disk. We generate them in tests so
// the suite can cover many file-source branches without copy-pasting nearly
// identical relay.yml files.
interface FileVersionSourceFixture {
  format: 'json' | 'yaml' | 'toml';
  path: string;
  keyPath: string[];
}

describe('versioning flexibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('supports date-time versioning for projects that need time-based uniqueness', async () => {
    const release = await normalizeWithFixture(fixtures.dateTime);
    expect(release.release.version).toBe('2026.05.22.191302');
    expect(release.release.tag).toBe('release-2026.05.22.191302');
  });

  it('supports explicit date-counter versioning for same-day multiple releases', async () => {
    const release = await normalizeWithFixture(fixtures.dateCounterExplicit);
    expect(release.release.version).toBe('2026.05.22.2');
    expect(release.release.tag).toBe('release-2026.05.22.2');
  });

  it('supports backend-style first release dates with no suffix', async () => {
    const release = await normalizeWithFixture(fixtures.backendFirst);
    expect(release.release.version).toBe('2026.05.22');
    expect(release.release.tag).toBe('release-2026.05.22');
  });

  it('supports backend-style later same-day releases with numeric suffixes', async () => {
    const release = await normalizeWithFixture(fixtures.backendThird);
    expect(release.release.version).toBe('2026.05.22.3');
    expect(release.release.tag).toBe('release-2026.05.22.3');
  });

  it('supports project-defined template schemas', async () => {
    const release = await normalizeWithFixture(fixtures.templateExplicit);
    expect(release.release.version).toBe('2026.05.22.4-9f3c1d2');
    expect(release.release.tag).toBe('release-2026.05.22.4-9f3c1d2');
  });

  it('supports reading a static JSON version from package.json via the file source', async () => {
    const release = await normalizeWithFixture(fixtures.filePackageJson);
    expect(release.release.version).toBe('2.3.4');
    expect(release.release.tag).toBe('v2.3.4');
  });

  it('supports reading nested JSON file versions', async () => {
    const release = await normalizeWithFixture(writeTempFileVersionConfig({
      format: 'json',
      path: fixtureRelativePath('version-file-json/version.json'),
      keyPath: ['release', 'version'],
    }));
    expect(release.release.version).toBe('5.6.7');
    expect(release.release.tag).toBe('v5.6.7');
  });

  it('supports reading YAML file versions', async () => {
    const release = await normalizeWithFixture(writeTempFileVersionConfig({
      format: 'yaml',
      path: fixtureRelativePath('version-file-yaml/release.yml'),
      keyPath: ['release', 'version'],
    }));
    expect(release.release.version).toBe('6.7.8');
    expect(release.release.tag).toBe('v6.7.8');
  });

  it('supports reading TOML file versions', async () => {
    const release = await normalizeWithFixture(writeTempFileVersionConfig({
      format: 'toml',
      path: fixtureRelativePath('version-file-toml/pyproject.toml'),
      keyPath: ['project', 'version'],
    }));
    expect(release.release.version).toBe('7.8.9');
    expect(release.release.tag).toBe('v7.8.9');
  });

  it('fails clearly when a configured version file is missing', async () => {
    await expect(normalizeWithFixture(writeTempFileVersionConfig({
      format: 'json',
      path: fixtureRelativePath('version-file-missing/version.json'),
      keyPath: ['release', 'version'],
    }))).rejects.toThrow('version_source.type=file could not find');
  });

  it('fails clearly when a configured version file cannot be parsed', async () => {
    await expect(normalizeWithFixture(writeTempFileVersionConfig({
      format: 'json',
      path: fixtureRelativePath('version-file-bad-parse/version.json'),
      keyPath: ['release', 'version'],
    }))).rejects.toThrow('version_source.type=file failed to parse json file');
  });

  it('fails clearly when key_path does not exist in the version file', async () => {
    await expect(normalizeWithFixture(writeTempFileVersionConfig({
      format: 'json',
      path: fixtureRelativePath('version-file-json/version.json'),
      keyPath: ['release', 'current'],
    }))).rejects.toThrow('version_source.type=file could not find key_path release.current');
  });

  it('fails clearly when the configured file value is not a string', async () => {
    await expect(normalizeWithFixture(writeTempFileVersionConfig({
      format: 'yaml',
      path: fixtureRelativePath('version-file-non-string/release.yml'),
      keyPath: ['release', 'version'],
    }))).rejects.toThrow('version_source.type=file requires');
  });

  it('supports environment-driven versioning from CI', async () => {
    const release = await normalizeWithFixture(fixtures.env, {
      RELAY_VERSION: '3.4.5',
    });
    expect(release.release.version).toBe('3.4.5');
    expect(release.release.tag).toBe('v3.4.5');
  });

  it('supports extracting the version from the current git tag', async () => {
    const release = await normalizeWithFixture(fixtures.gitTag, undefined, {
      tag: 'v4.5.6',
    });
    expect(release.release.version).toBe('4.5.6');
    expect(release.release.tag).toBe('v4.5.6');
  });

  it('can auto-increment backend-style same-day releases from existing tags', async () => {
    const fetchMock = mockTagList([
      tagEntry('release-2026.05.21', 'old-sha'),
      tagEntry('release-2026.05.22', 'sha-one'),
      tagEntry('release-2026.05.22.2', 'sha-two'),
    ]);

    const release = await normalizeWithFixture(fixtures.backendAuto, {
      GITHUB_TOKEN: 'test-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(release.release.version).toBe('2026.05.22.3');
    expect(release.release.tag).toBe('release-2026.05.22.3');
  });

  it('reuses the existing same-day counter when rerunning the same commit', async () => {
    const fetchMock = mockTagList([
      tagEntry('release-2026.05.22', 'different-sha'),
      tagEntry('release-2026.05.22.2', sha),
    ]);

    const release = await normalizeWithFixture(fixtures.backendAuto, {
      GITHUB_TOKEN: 'test-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(release.release.version).toBe('2026.05.22.2');
    expect(release.release.tag).toBe('release-2026.05.22.2');
  });

  it('supports dynamic semver from conventional commits', async () => {
    const repo = createTempGitRepo();
    commitFile(repo, 'README.md', 'base\n', 'chore: bootstrap');
    createTag(repo, 'v0.1.0');
    const headSha = commitFile(repo, 'feature.txt', 'new feature\n', 'feat: add file version source');
    writeRelayConfig(repo, `version_source:\n  type: conventional-commits\n  tag_prefix: v\ntag_template: v{version}`);

    const release = await normalizeTempRepo(repo, path.join(repo, '.github/relay.yml'), headSha);
    expect(release.release.version).toBe('0.2.0');
    expect(release.release.tag).toBe('v0.2.0');
  });

  it('reuses the latest semver tag when rerunning the same conventional-commit release commit', async () => {
    const repo = createTempGitRepo();
    commitFile(repo, 'README.md', 'base\n', 'chore: bootstrap');
    createTag(repo, 'v0.1.0');
    const headSha = commitFile(repo, 'feature.txt', 'new feature\n', 'feat: add file version source');
    createTag(repo, 'v0.2.0');
    writeRelayConfig(repo, `version_source:\n  type: conventional-commits\n  tag_prefix: v\ntag_template: v{version}`);

    const release = await normalizeTempRepo(repo, path.join(repo, '.github/relay.yml'), headSha);
    expect(release.release.version).toBe('0.2.0');
    expect(release.release.tag).toBe('v0.2.0');
  });

  it('ignores higher semver tags that are not reachable from the current commit', async () => {
    const repo = createTempGitRepo();
    commitFile(repo, 'README.md', 'base\n', 'chore: bootstrap');
    createTag(repo, 'v0.1.0');
    const headSha = commitFile(repo, 'feature.txt', 'new feature\n', 'feat: add file version source');
    runGit(repo, ['checkout', '-b', 'release-experiment', 'HEAD~1']);
    commitFile(repo, 'branch-only.txt', 'branch only\n', 'feat!: branch-only breaking change');
    createTag(repo, 'v9.0.0');
    runGit(repo, ['checkout', 'main']);
    writeRelayConfig(repo, `version_source:\n  type: conventional-commits\n  tag_prefix: v\ntag_template: v{version}`);

    const release = await normalizeTempRepo(repo, path.join(repo, '.github/relay.yml'), headSha);
    expect(release.release.version).toBe('0.2.0');
    expect(release.release.tag).toBe('v0.2.0');
  });

  it('supports dynamic semver from release-style tags without relying on tag_prefix parsing', async () => {
    const repo = createTempGitRepo();
    commitFile(repo, 'README.md', 'base\n', 'chore: bootstrap');
    createTag(repo, 'release-0.1.0');
    const headSha = commitFile(repo, 'feature.txt', 'new feature\n', 'feat: add file version source');
    writeRelayConfig(repo, `version_source:\n  type: conventional-commits\ntag_template: release-{version}`);

    const release = await normalizeTempRepo(repo, path.join(repo, '.github/relay.yml'), headSha);
    expect(release.release.version).toBe('0.2.0');
    expect(release.release.tag).toBe('release-0.2.0');
  });

  it('supports dynamic semver from pending changesets', async () => {
    const repo = createTempGitRepo();
    commitFile(repo, 'package.json', JSON.stringify({ name: '@example/component-library', version: '0.1.0' }, null, 2) + '\n', 'chore: bootstrap package');
    createTag(repo, 'v0.1.0');
    const changeset = `---\r\n"@example/component-library": minor\r\n---\r\n\r\nAdd support for the file version source.\r\n`;
    const headSha = commitFile(repo, '.changeset/blue-bird.md', changeset, 'docs: add release changeset');
    writeRelayConfig(repo, `version_source:\n  type: changesets\n  directory: .changeset\n  tag_prefix: v\ntag_template: v{version}\npackage:\n  name: '@example/component-library'`);

    const release = await normalizeTempRepo(repo, path.join(repo, '.github/relay.yml'), headSha);
    expect(release.release.version).toBe('0.2.0');
    expect(release.release.tag).toBe('v0.2.0');
  });
});

async function normalizeWithFixture(configPath: string, envOverrides?: StringMap, argsOverrides?: Partial<RuntimeArgs>): Promise<NormalizedRelease> {
  const args: RuntimeArgs = {
    repo: repository,
    sha,
    branch: 'main',
    ...(argsOverrides ?? {}),
  };
  if (args.tag) {
    delete args.branch;
  }

  return normalizeReleaseDocument({
    configPath,
    providerOverride: 'builtin:generic-env',
    dryRun: true,
    workspaceRoot: fixtureWorkspaceRoot,
    args,
    env: {
      ...(envOverrides ?? {}),
    },
  });
}

async function normalizeTempRepo(repoRoot: string, configPath: string, releaseSha: string): Promise<NormalizedRelease> {
  return normalizeReleaseDocument({
    configPath,
    providerOverride: 'builtin:generic-env',
    dryRun: true,
    workspaceRoot: repoRoot,
    args: {
      repo: repository,
      sha: releaseSha,
      branch: 'main',
    },
    env: {},
  });
}

function mockTagList(tags: GitHubTagListEntry[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    expect(url).toBe(`https://api.github.com/repos/${repository}/tags?per_page=100`);
    return new Response(JSON.stringify(tags), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function tagEntry(name: string, commitSha: string): GitHubTagListEntry {
  return {
    name,
    commit: {
      sha: commitSha,
    },
  };
}

function fixturePath(fileName: string): string {
  return path.resolve(import.meta.dirname, 'fixtures', fileName);
}

function fixtureRelativePath(fileName: string): string {
  return path.relative(fixtureWorkspaceRoot, fixturePath(fileName));
}

// Build one tiny relay.yml file per test case.
//
// Visual model:
//
//   one file format fixture
//      + one config shape
//      ↓
//   one focused runtime behavior test
function writeTempFileVersionConfig(source: FileVersionSourceFixture): string {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-version-config-'));
  tempDirs.push(configRoot);
  const configPath = path.join(configRoot, 'relay.yml');
  const keyPathBlock = source.keyPath.map((segment) => `    - ${segment}`).join('\n');
  const versionSourceBlock = `version_source:\n  type: file\n  format: ${source.format}\n  path: ${source.path}\n  key_path:\n${keyPathBlock}\ntag_template: v{version}`;
  fs.writeFileSync(configPath, buildRelayConfig(versionSourceBlock));
  return configPath;
}

function createTempGitRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-versioning-'));
  tempDirs.push(repoRoot);
  runGit(repoRoot, ['init', '-b', 'main']);
  runGit(repoRoot, ['config', 'user.name', 'Relay Test']);
  runGit(repoRoot, ['config', 'user.email', 'relay@example.com']);
  fs.mkdirSync(path.join(repoRoot, '.github'), { recursive: true });
  return repoRoot;
}

function writeRelayConfig(repoRoot: string, versionSourceBlock: string): void {
  fs.writeFileSync(path.join(repoRoot, '.github/relay.yml'), buildRelayConfig(versionSourceBlock));
}

function buildRelayConfig(versionSourceBlock: string): string {
  return `api_version: 1\nproduct_name: Example Service\nrelease_profile: deploy-release\nrelease_mode: framework-managed\nprovider_plugin: builtin:generic-env\nprofile_plugin: builtin:deploy-release\ntool_plugin: null\nartifact_publishers: []\nnotifiers: []\nmetadata_enrichers: []\nplugin_allowlist: []\nallow_local_plugins: false\nstable_branches:\n  - main\n${versionSourceBlock}\nnotes_source:\n  type: static\nplugin_config: {}\n`;
}

function commitFile(repoRoot: string, filePath: string, content: string, message: string): string {
  const absolutePath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  runGit(repoRoot, ['add', filePath]);
  runGit(repoRoot, ['commit', '-m', message]);
  return runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
}

function createTag(repoRoot: string, tagName: string): void {
  runGit(repoRoot, ['tag', tagName]);
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
