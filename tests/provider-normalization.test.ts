import path from 'node:path';

/**
 * These tests protect the most important provider promise:
 * different CI systems should describe the same logical release in the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeReleaseDocument } from '../src/core/orchestration/finalize-run.js';
import { buildCoreReleaseFields } from '../src/core/release-json/schema.js';
import type { ReleaseConfig } from '../src/core/config/types.js';

const configPath = path.resolve(import.meta.dirname, 'fixtures/relay.yml');
const githubEventPath = path.resolve(import.meta.dirname, 'fixtures/github-push-event.json');
const fixedNow = new Date('2026-05-22T19:13:02.000Z');
const sha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c';

describe('provider normalization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes equivalent GitHub Actions and CircleCI release context', async () => {
    const githubRelease = await normalizeReleaseDocument({
      configPath,
      providerOverride: 'builtin:github-actions',
      dryRun: true,
      args: {},
      env: {
        GITHUB_REPOSITORY: 'ExampleOrg/web-app',
        GITHUB_SHA: sha,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_NAME: 'main',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: githubEventPath,
        GITHUB_RUN_ID: '1234567890',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_ACTOR: 'monty',
      },
    });

    const circleRelease = await normalizeReleaseDocument({
      configPath,
      providerOverride: 'builtin:circleci',
      dryRun: true,
      args: {},
      env: {
        CIRCLE_PROJECT_USERNAME: 'ExampleOrg',
        CIRCLE_PROJECT_REPONAME: 'web-app',
        CIRCLE_SHA1: sha,
        CIRCLE_BRANCH: 'main',
        CIRCLE_BUILD_URL: 'https://circleci.com/gh/ExampleOrg/web-app/123',
        CIRCLE_BUILD_NUM: '123',
        CIRCLE_WORKFLOW_ID: 'workflow-1',
      },
    });

    expect(githubRelease.repository.full_name).toBe(circleRelease.repository.full_name);
    expect(githubRelease.git.sha).toBe(circleRelease.git.sha);
    expect(githubRelease.release.tag).toBe(circleRelease.release.tag);
    expect(githubRelease.profile.name).toBe(circleRelease.profile.name);
  });

  it('keeps notifier delivery policy visible in normalized release targets', () => {
    const fields = buildCoreReleaseFields(buildConfig({
      notifiers: [
        {
          plugin: 'builtin:slack-webhook',
          options: {
            delivery_policy: 'always',
          },
        },
      ],
    }), {
      owner: 'ExampleOrg',
      repo: 'web-app',
      sha,
      shortSha: sha.slice(0, 7),
      refName: 'main',
      stableBranch: true,
      dryRun: true,
      providerPlugin: 'builtin:generic-env',
      trigger: 'test',
      now: fixedNow,
      workspaceRoot: process.cwd(),
    });

    expect(fields.notifications.targets[0]).toMatchObject({
      plugin: 'builtin:slack-webhook',
      delivery_policy: 'always',
    });
  });
});

function buildConfig(overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    api_version: 1,
    product_name: 'Example Web App',
    release_profile: 'deploy-release',
    release_mode: 'framework-managed',
    provider_plugin: 'builtin:generic-env',
    profile_plugin: 'builtin:deploy-release',
    tool_plugin: null,
    artifact_publishers: [],
    notifiers: [],
    metadata_enrichers: [],
    plugin_allowlist: [],
    allow_local_plugins: false,
    stable_branches: ['main'],
    version_source: {
      type: 'date-sha',
    },
    tag_template: 'production-{date}-{short_sha}',
    notes_source: {
      type: 'associated-release-pr',
    },
    plugin_config: {},
    ...overrides,
  };
}
