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

const configPath = path.resolve(import.meta.dirname, 'fixtures/relay.yml');
const semanticConfigPath = path.resolve(import.meta.dirname, 'fixtures/semantic-release.yml');
const npmPackageConfigPath = path.resolve(import.meta.dirname, 'fixtures/npm-package.yml');
const fixedNow = new Date('2026-05-22T19:13:02.000Z');
const sha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c6a5d4e3f2a1b0c';
const frameworkRepository = 'ExampleOrg/web-app';
const semanticRepository = 'ExampleOrg/component-library';
const packageName = '@example/component-library';
const packageVersion = '2026.05.22-9f3c1d2';
const frameworkTag = 'production-2026.05.22-9f3c1d2';
const frameworkReleaseUrl = `https://github.com/${frameworkRepository}/releases/tag/${frameworkTag}`;
const semanticTag = 'v2026.05.22-9f3c1d2';
const semanticReleaseUrl = `https://github.com/${semanticRepository}/releases/tag/${semanticTag}`;
const slackWebhookUrl = 'https://hooks.slack.test/services/relay';
const notificationMarkerName = '.relay-notification-slack-webhook.json';

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

  it('treats a semantic-release run with no produced tag as a release noop', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await finalizeRun({
      configPath: semanticConfigPath,
      providerOverride: 'builtin:circleci',
      dryRun: false,
      args: {},
      env: {
        CIRCLE_PROJECT_USERNAME: 'ExampleOrg',
        CIRCLE_PROJECT_REPONAME: 'component-library',
        CIRCLE_SHA1: sha,
        CIRCLE_BRANCH: 'master',
        CIRCLE_BUILD_URL: 'https://circleci.com/gh/ExampleOrg/component-library/322',
        CIRCLE_BUILD_NUM: '322',
        CIRCLE_WORKFLOW_ID: 'workflow-noop',
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('noop');
    expect(result.release_mode).toBe('tool-observe');
    expect(result.notification_sent).toBe(false);
    expect(result.normalized_release.release.record).toMatchObject({
      owner: 'tool',
      status: 'noop',
    });
    expect(result.normalized_release.notifications.deliveries).toEqual([]);
    expect(result.normalized_release.extensions['builtin:semantic-release']).toMatchObject({
      observed: false,
      noop: true,
      reason: 'no release tag was provided by semantic-release',
    });
  });

  it('verifies npm package visibility before creating a GitHub release', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: npmPackageVersionUrl(packageName, packageVersion),
        status: 200,
        body: {
          name: packageName,
          version: packageVersion,
          dist: {
            tarball: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${packageVersion}.tgz`,
            integrity: 'sha512-test',
          },
        },
      },
      {
        method: 'GET',
        url: releaseByTagUrl(semanticRepository, semanticTag),
        status: 404,
        body: { message: 'Not Found' },
      },
      {
        method: 'GET',
        url: tagRefUrl(semanticRepository, semanticTag),
        status: 404,
        body: { message: 'Not Found' },
      },
      {
        method: 'POST',
        url: createTagRefUrl(semanticRepository),
        status: 201,
        body: { ref: `refs/tags/${semanticTag}` },
      },
      {
        method: 'POST',
        url: createReleaseUrl(semanticRepository),
        status: 201,
        body: releaseResponseBody(semanticRepository, 125, semanticTag, semanticReleaseUrl),
      },
    ]);

    const result = await finalizeRun({
      configPath: npmPackageConfigPath,
      providerOverride: 'builtin:generic-env',
      dryRun: false,
      args: {
        repo: semanticRepository,
        sha,
        branch: 'main',
      },
      env: {
        GITHUB_TOKEN: 'test-token',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.normalized_release.packages[0]).toMatchObject({
      provider: 'builtin:npm-registry-verify',
      status: 'visible',
      name: packageName,
      version: packageVersion,
    });
    expect(result.normalized_release.release.record.status).toBe('created');
    expect(result.phases.indexOf('artifact-phase')).toBeLessThan(result.phases.indexOf('release-record'));
  });

  it('does not create a GitHub release when npm package visibility fails', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: npmPackageVersionUrl(packageName, packageVersion),
        status: 404,
        body: { error: 'not_found' },
      },
    ]);

    await expect(finalizeRun({
      configPath: npmPackageConfigPath,
      providerOverride: 'builtin:generic-env',
      dryRun: false,
      args: {
        repo: semanticRepository,
        sha,
        branch: 'main',
      },
      env: {
        GITHUB_TOKEN: 'test-token',
      },
    })).rejects.toThrow(`npm package ${packageName}@${packageVersion} is not visible`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
          upload_url: releaseUploadUrl(frameworkRepository, 77),
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
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 77, frameworkTag, frameworkReleaseUrl),
      },
      {
        method: 'GET',
        url: releaseAssetsUrl(frameworkRepository, 77),
        status: 200,
        body: [],
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
      {
        method: 'POST',
        url: notificationMarkerUploadUrl(frameworkRepository, 77),
        status: 201,
        body: {
          id: 701,
          name: notificationMarkerName,
        },
        assertBody(body) {
          expect(body).toMatchObject({
            plugin: 'builtin:slack-webhook',
            release_tag: frameworkTag,
            release_url: frameworkReleaseUrl,
            delivery_status: 'ok',
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

    expect(fetchMock).toHaveBeenCalledTimes(8);
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
          upload_url: releaseUploadUrl(frameworkRepository, 91),
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
          upload_url: releaseUploadUrl(frameworkRepository, 91),
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
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 91, frameworkTag, frameworkReleaseUrl),
      },
      {
        method: 'GET',
        url: releaseAssetsUrl(frameworkRepository, 91),
        status: 200,
        body: [],
      },
      {
        method: 'POST',
        url: slackWebhookUrl,
        status: 200,
        body: { ok: true },
      },
      {
        method: 'POST',
        url: notificationMarkerUploadUrl(frameworkRepository, 91),
        status: 201,
        body: {
          id: 702,
          name: notificationMarkerName,
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

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.normalized_release.release.record.status).toBe('updated');
    expect(result.notification_sent).toBe(true);
  });

	  it('skips Slack delivery when the release already has the notification marker', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: {
          id: 92,
          html_url: frameworkReleaseUrl,
          upload_url: releaseUploadUrl(frameworkRepository, 92),
          tag_name: frameworkTag,
          name: 'Existing release title',
          body: 'Existing body',
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
        url: updateReleaseUrl(frameworkRepository, 92),
        status: 200,
        body: {
          id: 92,
          html_url: frameworkReleaseUrl,
          upload_url: releaseUploadUrl(frameworkRepository, 92),
          tag_name: frameworkTag,
          name: 'Example Web App 2026.05.22-9f3c1d2',
          body: 'Example Web App release 2026.05.22-9f3c1d2.',
          prerelease: false,
          published_at: fixedNow.toISOString(),
        },
      },
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 92, frameworkTag, frameworkReleaseUrl),
      },
      {
        method: 'GET',
        url: releaseAssetsUrl(frameworkRepository, 92),
        status: 200,
        body: [
          {
            id: 800,
            name: notificationMarkerName,
            browser_download_url: `https://github.com/${frameworkRepository}/releases/download/${frameworkTag}/${notificationMarkerName}`,
          },
        ],
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
    expect(result.notification_sent).toBe(false);
    expect(result.normalized_release.notifications.deliveries[0]).toMatchObject({
      plugin: 'builtin:slack-webhook',
      status: 'skipped',
      details: {
        reason: 'notification marker exists',
        marker_name: notificationMarkerName,
      },
    });
  });

  it('force-sends Slack delivery even when the notification marker already exists', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 94, frameworkTag, frameworkReleaseUrl),
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
        url: updateReleaseUrl(frameworkRepository, 94),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 94, frameworkTag, frameworkReleaseUrl),
      },
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 94, frameworkTag, frameworkReleaseUrl),
      },
      {
        method: 'GET',
        url: releaseAssetsUrl(frameworkRepository, 94),
        status: 200,
        body: [
          {
            id: 801,
            name: notificationMarkerName,
            browser_download_url: `https://github.com/${frameworkRepository}/releases/download/${frameworkTag}/${notificationMarkerName}`,
          },
        ],
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
        force_notify: true,
      },
      env: {
        GITHUB_TOKEN: 'test-token',
        SLACK_WEBHOOK_URL: slackWebhookUrl,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.notification_sent).toBe(true);
    expect(result.normalized_release.notifications.deliveries[0]).toMatchObject({
      plugin: 'builtin:slack-webhook',
      status: 'sent',
    });
  });

  it('fails before Slack when the notification marker cannot be checked', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 93, frameworkTag, frameworkReleaseUrl),
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
        url: updateReleaseUrl(frameworkRepository, 93),
        status: 200,
        body: releaseResponseBody(frameworkRepository, 93, frameworkTag, frameworkReleaseUrl),
      },
      {
        method: 'GET',
        url: releaseByTagUrl(frameworkRepository, frameworkTag),
        status: 404,
        body: { message: 'Not Found' },
      },
    ]);

    await expect(finalizeRun({
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
    })).rejects.toThrow(`cannot check notification marker for ${frameworkTag}`);

    expect(fetchMock).toHaveBeenCalledTimes(4);
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
          upload_url: releaseUploadUrl(semanticRepository, 123),
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
        method: 'GET',
        url: releaseByTagUrl(semanticRepository, semanticTag),
        status: 200,
        body: releaseResponseBody(semanticRepository, 123, semanticTag, semanticReleaseUrl),
      },
      {
        method: 'GET',
        url: releaseAssetsUrl(semanticRepository, 123),
        status: 200,
        body: [],
      },
      {
        method: 'POST',
        url: slackWebhookUrl,
        status: 200,
        body: { ok: true },
      },
      {
        method: 'POST',
        url: notificationMarkerUploadUrl(semanticRepository, 123),
        status: 201,
        body: {
          id: 703,
          name: notificationMarkerName,
        },
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

    expect(fetchMock).toHaveBeenCalledTimes(6);
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

function releaseAssetsUrl(repository: string, releaseId: number): string {
  return `https://api.github.com/repos/${repository}/releases/${releaseId}/assets`;
}

function releaseUploadUrl(repository: string, releaseId: number): string {
  return `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets{?name,label}`;
}

function notificationMarkerUploadUrl(repository: string, releaseId: number): string {
  return `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(notificationMarkerName)}`;
}

function npmPackageVersionUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

function releaseResponseBody(repository: string, id: number, tag: string, releaseUrl: string) {
  return {
    id,
    html_url: releaseUrl,
    upload_url: releaseUploadUrl(repository, id),
    tag_name: tag,
    name: `Release ${tag}`,
    body: 'release body',
    prerelease: false,
    published_at: fixedNow.toISOString(),
  };
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
