import path from 'node:path';

/**
 * These tests focus on finalize semantics instead of raw provider parsing.
 *
 * They document three early framework promises:
 * - framework-managed dry-runs stay deterministic
 * - semantic-release observe mode keeps tool ownership intact
 * - profile / ref overrides keep the release document internally consistent
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { finalizeRun } from '../src/core/orchestration/finalize-run.js';
import type { JsonValue } from '../src/core/types/json.js';

const configPath = path.resolve(import.meta.dirname, 'fixtures/release-framework.yml');
const semanticConfigPath = path.resolve(import.meta.dirname, 'fixtures/semantic-release.yml');
const fixedNow = new Date('2026-05-22T19:13:02.000Z');
const sha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c6a5d4e3f2a1b0c';
const frameworkRepository = 'ExampleOrg/web-app';
const semanticRepository = 'ExampleOrg/component-library';
const frameworkTag = 'production-2026.05.22-9f3c1d2';
const frameworkReleaseUrl = `https://github.com/${frameworkRepository}/releases/tag/${frameworkTag}`;
const semanticTag = 'v2026.05.22-9f3c1d2';
const semanticReleaseUrl = `https://github.com/${semanticRepository}/releases/tag/${semanticTag}`;
const slackWebhookUrl = 'https://hooks.slack.test/services/release-framework';

interface MockFetchResponse {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  status: number;
  body: JsonValue;
  assertBody?: (body: unknown) => void;
}

describe('finalize run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('produces a dry-run finalize result for framework-managed releases', async () => {
    const result = await finalizeRun({
      configPath,
      providerOverride: 'builtin:generic-env',
      dryRun: true,
      args: {
        repo: frameworkRepository,
        sha,
        branch: 'main',
      },
    });

    expect(result.status).toBe('ok');
    expect(result.release_tag).toBe(frameworkTag);
    expect(result.notification_sent).toBe(false);
    expect(result.normalized_release.notifications.deliveries).toHaveLength(1);
  });

  it('observes semantic-release without switching ownership back to core', async () => {
    const result = await finalizeRun({
      configPath: semanticConfigPath,
      providerOverride: 'builtin:circleci',
      dryRun: true,
      args: {
        tag: semanticTag,
      },
      env: {
        CIRCLE_PROJECT_USERNAME: 'ExampleOrg',
        CIRCLE_PROJECT_REPONAME: 'component-library',
        CIRCLE_SHA1: sha,
        CIRCLE_BRANCH: 'master',
        CIRCLE_BUILD_URL: 'https://circleci.com/gh/ExampleOrg/component-library/321',
        CIRCLE_BUILD_NUM: '321',
        CIRCLE_WORKFLOW_ID: 'workflow-2',
        RELEASE_TAG: semanticTag,
      },
    });

    expect(result.release_mode).toBe('tool-observe');
    expect(result.normalized_release.release.record.owner).toBe('tool');
    expect(result.release_tag).toBe(semanticTag);
  });

  it('creates a GitHub release and tag when neither exists yet', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 404,
        body: { message: 'Not Found' },
      },
      {
        method: 'GET',
        url: tagRefUrl(frameworkRepository, frameworkTag),
        status: 404,
        body: { message: 'Not Found' },
      },
      {
        method: 'POST',
        url: createTagRefUrl(frameworkRepository),
        status: 201,
        body: { ref: `refs/tags/${frameworkTag}` },
        assertBody(body) {
          expect(body).toEqual({
            ref: `refs/tags/${frameworkTag}`,
            sha,
          });
        },
      },
      {
        method: 'POST',
        url: createReleaseUrl(frameworkRepository),
        status: 201,
        body: {
          id: 77,
          html_url: frameworkReleaseUrl,
          tag_name: frameworkTag,
          name: 'Example Web App 2026.05.22-9f3c1d2',
          body: 'Example Web App release 2026.05.22-9f3c1d2.',
          prerelease: false,
          published_at: fixedNow.toISOString(),
        },
        assertBody(body) {
          expect(body).toEqual({
            tag_name: frameworkTag,
            target_commitish: sha,
            name: 'Example Web App 2026.05.22-9f3c1d2',
            body: 'Example Web App release 2026.05.22-9f3c1d2.',
            prerelease: false,
            draft: false,
          });
        },
      },
      {
        method: 'POST',
        url: slackWebhookUrl,
        status: 200,
        body: { ok: true },
        assertBody(body) {
          expect(body).toMatchObject({
            text: `web-app ${frameworkTag}`,
          });
        },
      },
    ]);

    const result = await finalizeRun({
      configPath,
      providerOverride: 'builtin:generic-env',
      dryRun: false,
      args: {
        repo: frameworkRepository,
        sha,
        branch: 'main',
      },
      env: {
        GITHUB_TOKEN: 'test-token',
        SLACK_WEBHOOK_URL: slackWebhookUrl,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.release_url).toBe(frameworkReleaseUrl);
    expect(result.notification_sent).toBe(true);
    expect(result.normalized_release.release.record.status).toBe('created');
    expect(result.normalized_release.notifications.deliveries[0]?.status).toBe('sent');
  });

  it('updates an existing GitHub release instead of creating a duplicate', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: {
          id: 91,
          html_url: frameworkReleaseUrl,
          tag_name: frameworkTag,
          name: 'Old release title',
          body: 'Old body',
          prerelease: false,
          published_at: fixedNow.toISOString(),
        },
      },
      {
        method: 'GET',
        url: tagRefUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: {
          ref: `refs/tags/${frameworkTag}`,
          object: {
            type: 'commit',
            sha,
            url: commitApiUrl(frameworkRepository, 'example'),
          },
        },
      },
      {
        method: 'PATCH',
        url: updateReleaseUrl(frameworkRepository, 91),
        status: 200,
        body: {
          id: 91,
          html_url: frameworkReleaseUrl,
          tag_name: frameworkTag,
          name: 'Example Web App 2026.05.22-9f3c1d2',
          body: 'Example Web App release 2026.05.22-9f3c1d2.',
          prerelease: false,
          published_at: fixedNow.toISOString(),
        },
        assertBody(body) {
          expect(body).toEqual({
            target_commitish: sha,
            name: 'Example Web App 2026.05.22-9f3c1d2',
            body: 'Example Web App release 2026.05.22-9f3c1d2.',
            prerelease: false,
          });
        },
      },
      {
        method: 'POST',
        url: slackWebhookUrl,
        status: 200,
        body: { ok: true },
      },
    ]);

    const result = await finalizeRun({
      configPath,
      providerOverride: 'builtin:generic-env',
      dryRun: false,
      args: {
        repo: frameworkRepository,
        sha,
        branch: 'main',
      },
      env: {
        GITHUB_TOKEN: 'test-token',
        SLACK_WEBHOOK_URL: slackWebhookUrl,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.normalized_release.release.record.status).toBe('updated');
    expect(result.notification_sent).toBe(true);
  });

  it('observes an existing tool-owned GitHub release without creating one', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: releaseByTagUrl(semanticRepository, semanticTag),
        status: 200,
        body: {
          id: 123,
          html_url: semanticReleaseUrl,
          tag_name: semanticTag,
          name: 'Component Library v2026.05.22-9f3c1d2',
          body: 'release body',
          prerelease: false,
          published_at: fixedNow.toISOString(),
        },
      },
      {
        method: 'GET',
        url: tagRefUrl(semanticRepository, semanticTag),
        status: 200,
        body: {
          ref: `refs/tags/${semanticTag}`,
          object: {
            type: 'commit',
            sha,
            url: commitApiUrl(semanticRepository, 'example'),
          },
        },
      },
      {
        method: 'POST',
        url: slackWebhookUrl,
        status: 200,
        body: { ok: true },
      },
    ]);

    const result = await finalizeRun({
      configPath: semanticConfigPath,
      providerOverride: 'builtin:circleci',
      dryRun: false,
      args: {
        tag: semanticTag,
      },
      env: {
        GITHUB_TOKEN: 'test-token',
        SLACK_WEBHOOK_URL: slackWebhookUrl,
        CIRCLE_PROJECT_USERNAME: 'ExampleOrg',
        CIRCLE_PROJECT_REPONAME: 'component-library',
        CIRCLE_SHA1: sha,
        CIRCLE_BRANCH: 'master',
        CIRCLE_BUILD_URL: 'https://circleci.com/gh/ExampleOrg/component-library/321',
        CIRCLE_BUILD_NUM: '321',
        CIRCLE_WORKFLOW_ID: 'workflow-2',
        RELEASE_TAG: semanticTag,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.release_url).toBe(semanticReleaseUrl);
    expect(result.normalized_release.release.record.status).toBe('observed');
    expect(result.notification_sent).toBe(true);
  });

  it('maps built-in profile overrides to the matching profile plugin', async () => {
    const result = await finalizeRun({
      configPath,
      providerOverride: 'builtin:generic-env',
      profileOverride: 'asset-release',
      dryRun: true,
      args: {
        repo: frameworkRepository,
        sha,
        branch: 'main',
        completion_status: 'pending',
      },
    });

    expect(result.profile).toBe('asset-release');
    expect(result.normalized_release.profile.release_record_timing).toBe('before_artifacts');
    expect(result.normalized_release.profile.artifact_completion_required).toBe(true);
  });

  it('keeps prerelease state in sync when release_ref overrides the git ref', async () => {
    const result = await finalizeRun({
      configPath,
      providerOverride: 'builtin:generic-env',
      dryRun: true,
      args: {
        repo: frameworkRepository,
        sha,
        branch: 'main',
        release_ref: 'refs/heads/release-candidate',
      },
    });

    expect(result.normalized_release.git.ref_name).toBe('release-candidate');
    expect(result.normalized_release.git.stable_branch).toBe(false);
    expect(result.normalized_release.release.prerelease).toBe(true);
  });

  it('uses the tag name as the release tag when release_ref points at a tag ref', async () => {
    const result = await finalizeRun({
      configPath,
      providerOverride: 'builtin:generic-env',
      dryRun: true,
      args: {
        repo: frameworkRepository,
        sha,
        branch: 'main',
        release_ref: 'refs/tags/v2026.05.22-9f3c1d2',
      },
    });

    expect(result.normalized_release.git.ref_type).toBe('tag');
    expect(result.release_tag).toBe('v2026.05.22-9f3c1d2');
    expect(result.normalized_release.release.record.idempotency_key).toBe(`${frameworkRepository}:v2026.05.22-9f3c1d2`);
  });
});

function releaseByTagUrl(repository: string, tag: string): string {
  return `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
}

function tagRefUrl(repository: string, tag: string): string {
  return `https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
}

function createTagRefUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/git/refs`;
}

function createReleaseUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/releases`;
}

function updateReleaseUrl(repository: string, releaseId: number): string {
  return `https://api.github.com/repos/${repository}/releases/${releaseId}`;
}

function commitApiUrl(repository: string, shaRef: string): string {
  return `https://api.github.com/repos/${repository}/git/commits/${shaRef}`;
}

function mockFetchResponses(responses: MockFetchResponse[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const next = responses.shift();
    expect(next).toBeDefined();

    expect(String(input)).toBe(next?.url);
    expect(init?.method ?? 'GET').toBe(next?.method);

    if (next?.assertBody) {
      const parsedBody = typeof init?.body === 'string'
        ? JSON.parse(init.body)
        : init?.body;
      next.assertBody(parsedBody);
    }

    return new Response(JSON.stringify(next?.body ?? null), {
      status: next?.status ?? 500,
      headers: {
        'content-type': 'application/json',
      },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
