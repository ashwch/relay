import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeReleaseDocument } from '../src/core/orchestration/finalize-run.js';
import type { NormalizedRelease } from '../src/core/release-json/schema.js';
import type { StringMap } from '../src/core/types/runtime.js';

/**
 * Versioning tests document one critical framework promise:
 * projects can choose different release version schemas without changing core.
 */
const fixedNow = new Date('2026-05-22T19:13:02.000Z');
const sha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c';
const repository = 'ExampleOrg/example-service';

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
};

describe('versioning flexibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
});

async function normalizeWithFixture(configPath: string, envOverrides?: StringMap): Promise<NormalizedRelease> {
  return normalizeReleaseDocument({
    configPath,
    providerOverride: 'builtin:generic-env',
    dryRun: true,
    args: {
      repo: repository,
      sha,
      branch: 'main',
    },
    env: {
      ...(envOverrides ?? {}),
    },
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
