import type { NormalizedRelease } from '../../src/core/release-json/schema.js';

export const fixtureRepository = 'ExampleOrg/web-app';
export const fixtureSha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c';
export const fixtureShortSha = '9f3c1d2';
export const fixtureReleaseTag = 'production-2026.05.22-9f3c1d2';
export const fixtureReleaseVersion = '2026.05.22-9f3c1d2';
export const fixturePublishedAt = '2026-05-22T19:13:02.000Z';

const fixtureRepositoryName = 'web-app';
const fixtureProductName = 'Example Web App';

export function buildNormalizedRelease(overrides: Partial<NormalizedRelease> = {}): NormalizedRelease {
  return {
    schema_version: 'release-framework.release/v1',
    run: {
      id: 'run-1',
      dry_run: false,
      provider: 'builtin:generic-env',
      trigger: 'manual',
    },
    source: {},
    repository: {
      owner: 'ExampleOrg',
      name: fixtureRepositoryName,
      full_name: fixtureRepository,
      url: `https://github.com/${fixtureRepository}`,
    },
    git: {
      ref: 'refs/heads/main',
      ref_name: 'main',
      ref_type: 'branch',
      sha: fixtureSha,
      short_sha: fixtureShortSha,
      stable_branch: true,
    },
    profile: {
      name: 'deploy-release',
      release_mode: 'framework-managed',
      completion_gate: 'deploy_succeeded',
      release_record_timing: 'after_completion',
    },
    release: {
      version: fixtureReleaseVersion,
      tag: fixtureReleaseTag,
      name: `${fixtureProductName} ${fixtureReleaseVersion}`,
      body: `${fixtureProductName} release ${fixtureReleaseVersion}.`,
      prerelease: false,
      target_sha: fixtureSha,
      published_at: fixturePublishedAt,
      url: `https://github.com/${fixtureRepository}/releases/tag/${fixtureReleaseTag}`,
      record: {
        system: 'github',
        owner: 'core',
        status: 'created',
        idempotency_key: `${fixtureRepository}:${fixtureReleaseTag}`,
      },
    },
    completion: {
      status: 'completed',
      completed_at: fixturePublishedAt,
      evidence: [],
    },
    artifacts: [],
    packages: [],
    pull_requests: [],
    notifications: {
      targets: [],
      deliveries: [],
    },
    links: {
      workflow_url: `https://github.com/${fixtureRepository}/actions/runs/1`,
    },
    extensions: {},
    ...overrides,
  };
}
