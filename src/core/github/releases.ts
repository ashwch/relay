import type { GitHubClient } from './client.js';
import { assertExpectedTagTarget, createTagReference, readTagTargetSha } from './tags.js';

/**
 * This file owns one very important piece of behavior:
 * deciding whether the framework should create, update, or merely observe the
 * durable GitHub Release record.
 *
 * It exists so the orchestration layer can stay readable and high-level.
 */

/**
 * GitHub Release helpers.
 *
 * These functions handle the durable release record for the framework-managed
 * path and validate existing records for observe mode.
 */
export interface GitHubReleaseResponse {
  id: number;
  html_url: string;
  upload_url?: string;
  tag_name: string;
  name: string | null;
  body: string | null;
  prerelease: boolean;
  published_at: string | null;
}

export interface GitHubReleaseAssetResponse {
  id: number;
  name: string;
  browser_download_url?: string;
}

export type ReleaseRecordStatus = 'created' | 'updated' | 'observed' | 'noop';

export interface GitHubReleaseRecordResult {
  status: ReleaseRecordStatus;
  url: string;
  publishedAt: string | null;
}

export interface NotificationMarkerState {
  markerName: string;
  exists: boolean;
  uploadUrl: string;
  asset?: GitHubReleaseAssetResponse;
}

interface ReleaseMutationInput {
  tag: string;
  targetSha: string;
  name: string;
  body: string;
  prerelease: boolean;
}

interface GitHubReleaseMutationPayload {
  tag_name?: string;
  target_commitish: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft?: boolean;
  [key: string]: boolean | string | undefined;
}

/**
 * Create or update the GitHub Release when the framework is the record owner.
 *
 * Visual algorithm:
 *
 *   release exists?  -> verify tag target -> update release
 *   no release, tag? -> verify tag target -> create release
 *   neither exists?  -> create tag        -> create release
 */
export async function ensureFrameworkManagedGitHubRelease(
  client: GitHubClient,
  input: ReleaseMutationInput,
  dryRun: boolean,
): Promise<GitHubReleaseRecordResult> {
  if (dryRun) {
    return {
      status: 'noop',
      url: buildReleaseUrl(client, input.tag),
      publishedAt: null,
    };
  }

  const existingRelease = await readReleaseByTag(client, input.tag);
  const existingTagTarget = await readTagTargetSha(client, input.tag);

  if (existingRelease) {
    assertExpectedTagTarget(input.tag, existingTagTarget, input.targetSha);
    const updatedRelease = await updateRelease(client, existingRelease.id, toReleaseMutationPayload(input));
    return {
      status: 'updated',
      url: updatedRelease.html_url,
      publishedAt: updatedRelease.published_at,
    };
  }

  if (existingTagTarget) {
    assertExpectedTagTarget(input.tag, existingTagTarget, input.targetSha);
  } else {
    await createTagReference(client, input.tag, input.targetSha);
  }

  const createdRelease = await createRelease(client, {
    ...toReleaseMutationPayload(input),
    tag_name: input.tag,
    draft: false,
  });

  return {
    status: 'created',
    url: createdRelease.html_url,
    publishedAt: createdRelease.published_at,
  };
}

/**
 * Verify that a tool-owned release already exists and matches the expected tag
 * and commit.
 *
 * This is the key anti-duplication path for semantic-release style repos.
 */
export async function observeGitHubRelease(
  client: GitHubClient,
  tag: string,
  expectedSha: string,
  dryRun: boolean,
): Promise<GitHubReleaseRecordResult> {
  if (dryRun) {
    return {
      status: 'noop',
      url: buildReleaseUrl(client, tag),
      publishedAt: null,
    };
  }

  const release = await readReleaseByTag(client, tag);
  if (!release) {
    throw new Error(`GitHub Release for tag ${tag} does not exist`);
  }

  const tagTarget = await readTagTargetSha(client, tag);
  assertExpectedTagTarget(tag, tagTarget, expectedSha);

  return {
    status: 'observed',
    url: release.html_url,
    publishedAt: release.published_at,
  };
}

/**
 * Read the framework-owned notification marker for one notifier target.
 *
 * The marker is a tiny release asset. It is deliberately outside Slack, because
 * Slack incoming webhooks do not give us a stable message id that can be used
 * safely on reruns.
 */
export async function readNotificationMarker(
  client: GitHubClient,
  tag: string,
  markerKey: string,
): Promise<NotificationMarkerState | null> {
  const release = await readReleaseByTag(client, tag);
  if (!release) {
    return null;
  }
  if (!release.upload_url) {
    throw new Error(`GitHub Release ${tag} response did not include upload_url required for notification marker writes`);
  }

  const markerName = buildNotificationMarkerAssetName(markerKey);
  const assets = await listReleaseAssets(client, release.id);
  return {
    markerName,
    exists: assets.some((asset) => asset.name === markerName),
    uploadUrl: release.upload_url,
    asset: assets.find((asset) => asset.name === markerName),
  };
}

/**
 * Write the notification marker only after the notifier side effect succeeds.
 *
 * The asset body is intentionally operational metadata only. It must not contain
 * webhook URLs or other secret values.
 */
export async function writeNotificationMarker(
  client: GitHubClient,
  marker: NotificationMarkerState,
  body: unknown,
): Promise<void> {
  client.requireToken();
  if (marker.exists) {
    return;
  }

  await uploadReleaseAsset(client, marker.uploadUrl, marker.markerName, body);
}

/**
 * Look up a release by tag because tag identity is the framework's main
 * idempotency anchor in v1.
 */
async function readReleaseByTag(client: GitHubClient, tag: string): Promise<GitHubReleaseResponse | null> {
  return client.requestJson<GitHubReleaseResponse>({
    method: 'GET',
    path: `/repos/${client.repository.owner}/${client.repository.name}/releases/tags/${encodeURIComponent(tag)}`,
    allowNotFound: true,
  });
}

async function listReleaseAssets(client: GitHubClient, releaseId: number): Promise<GitHubReleaseAssetResponse[]> {
  const assets = await client.requestJson<GitHubReleaseAssetResponse[]>({
    method: 'GET',
    path: `/repos/${client.repository.owner}/${client.repository.name}/releases/${releaseId}/assets`,
  });
  return assets ?? [];
}

async function uploadReleaseAsset(
  client: GitHubClient,
  uploadUrlTemplate: string,
  name: string,
  body: unknown,
): Promise<GitHubReleaseAssetResponse> {
  const uploadUrl = `${uploadUrlTemplate.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`;
  const uploaded = await client.requestUrlJson<GitHubReleaseAssetResponse>({
    method: 'POST',
    url: uploadUrl,
    body,
  });

  if (!uploaded) {
    throw new Error(`notification marker upload ${name} returned no response body`);
  }
  return uploaded;
}

async function updateRelease(
  client: GitHubClient,
  releaseId: number,
  payload: GitHubReleaseMutationPayload,
): Promise<GitHubReleaseResponse> {
  client.requireToken();
  const updated = await client.requestJson<GitHubReleaseResponse>({
    method: 'PATCH',
    path: `/repos/${client.repository.owner}/${client.repository.name}/releases/${releaseId}`,
    body: payload,
  });

  if (!updated) {
    throw new Error(`GitHub Release ${releaseId} update returned no response body`);
  }

  return updated;
}

async function createRelease(
  client: GitHubClient,
  payload: GitHubReleaseMutationPayload,
): Promise<GitHubReleaseResponse> {
  client.requireToken();
  const created = await client.requestJson<GitHubReleaseResponse>({
    method: 'POST',
    path: `/repos/${client.repository.owner}/${client.repository.name}/releases`,
    body: payload,
  });

  if (!created) {
    throw new Error('GitHub Release creation returned no response body');
  }

  return created;
}

/**
 * Convert internal release facts into the exact GitHub payload shape we want to
 * send over the API.
 */
function toReleaseMutationPayload(input: ReleaseMutationInput): GitHubReleaseMutationPayload {
  return {
    target_commitish: input.targetSha,
    name: input.name,
    body: input.body,
    prerelease: input.prerelease,
  };
}

/**
 * Predict the public GitHub release URL from repo identity + tag.
 *
 * This is especially useful in dry-run mode where we want a realistic result
 * without mutating GitHub.
 */
function buildReleaseUrl(client: GitHubClient, tag: string): string {
  return `https://github.com/${client.repository.owner}/${client.repository.name}/releases/tag/${encodeURIComponent(tag)}`;
}

function buildNotificationMarkerAssetName(markerKey: string): string {
  const safeKey = markerKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `.relay-notification-${safeKey || 'target'}.json`;
}
