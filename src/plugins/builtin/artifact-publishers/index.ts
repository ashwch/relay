import { createGitHubClient } from '../../../core/github/client.js';
import { okResponse, type PluginHandler, type PluginRequest } from '../../../core/plugins/request-response.js';
import type { JsonObject, JsonValue } from '../../../core/types/json.js';

interface GitHubReleaseForAssets {
  id: number;
  html_url: string;
  tag_name: string;
}

interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  browser_download_url: string;
  content_type?: string | null;
}

interface NpmRegistryPackageVersion {
  name?: string;
  version?: string;
  dist?: {
    tarball?: string;
    shasum?: string;
    integrity?: string;
  };
}

const defaultNpmRegistryUrl = 'https://registry.npmjs.org';
const githubReleaseAssetsPlugin = 'builtin:github-release-assets';
const npmRegistryVerifyPlugin = 'builtin:npm-registry-verify';
const s3ManifestPublishPlugin = 'builtin:s3-manifest-publish';

const githubReleaseAssetsPublisher: PluginHandler = {
  async verify(request) {
    if (!request.release) {
      throw new Error('github release assets verify requires release document');
    }

    const requiredAssets = readStringArray(request.config, ['required_assets', 'required', 'asset_names']);
    if (requiredAssets.length === 0) {
      return okResponse({}, {
        verification: {
          provider: githubReleaseAssetsPlugin,
          status: 'skipped',
          reason: 'no required assets configured',
        },
      }, 'github release asset verification skipped');
    }

    if (request.dry_run) {
      return okResponse(appendArtifactPatch(request, {
        provider: githubReleaseAssetsPlugin,
        status: 'dry-run',
        required_assets: requiredAssets,
      }), {
        verification: {
          provider: githubReleaseAssetsPlugin,
          status: 'dry-run',
          required_assets: requiredAssets,
        },
      }, 'github release asset verification dry-run');
    }

    const client = createGitHubClient({
      owner: request.release.repository.owner,
      name: request.release.repository.name,
    }, request.inputs.env);
    const release = await readGitHubReleaseByTag(client, request.release.release.tag);
    const assets = await listGitHubReleaseAssets(client, release.id);
    const missingAssets = requiredAssets.filter((requiredAsset) => !assets.some((asset) => asset.name === requiredAsset));
    if (missingAssets.length > 0) {
      throw new Error(`GitHub Release ${request.release.release.tag} is missing required assets: ${missingAssets.join(', ')}`);
    }

    const matchedAssets = assets.filter((asset) => requiredAssets.includes(asset.name));
    return okResponse(appendArtifactPatch(request, {
      provider: githubReleaseAssetsPlugin,
      status: 'verified',
      release_url: release.html_url,
      assets: matchedAssets.map(toReleaseAssetJson),
      verified_at: new Date().toISOString(),
    }), {
      verification: {
        provider: githubReleaseAssetsPlugin,
        status: 'verified',
        required_assets: requiredAssets,
        matched_assets: matchedAssets.map((asset) => asset.name),
      },
    }, 'verified github release assets');
  },
};

const npmRegistryVerifier: PluginHandler = {
  async verify(request) {
    if (!request.release) {
      throw new Error('npm registry verify requires release document');
    }

    const packageName = readStringOption(request.config, ['name', 'package_name']);
    if (!packageName) {
      return okResponse({}, {
        verification: {
          provider: npmRegistryVerifyPlugin,
          status: 'skipped',
          reason: 'no package name configured',
        },
      }, 'npm package verification skipped');
    }

    const packageVersion = readStringOption(request.config, ['version']) ?? request.release.release.version;
    const registryUrl = normalizeRegistryUrl(readStringOption(request.config, ['registry_url']) ?? defaultNpmRegistryUrl);
    if (request.dry_run) {
      return okResponse(appendPackagePatch(request, {
        provider: npmRegistryVerifyPlugin,
        status: 'dry-run',
        name: packageName,
        version: packageVersion,
        registry_url: registryUrl,
      }), {
        verification: {
          provider: npmRegistryVerifyPlugin,
          status: 'dry-run',
          name: packageName,
          version: packageVersion,
          registry_url: registryUrl,
        },
      }, 'npm package verification dry-run');
    }

    const registryVersion = await fetchNpmPackageVersion(registryUrl, packageName, packageVersion);
    return okResponse(appendPackagePatch(request, {
      provider: npmRegistryVerifyPlugin,
      status: 'visible',
      name: registryVersion.name ?? packageName,
      version: registryVersion.version ?? packageVersion,
      registry_url: registryUrl,
      tarball_url: registryVersion.dist?.tarball ?? null,
      integrity: registryVersion.dist?.integrity ?? registryVersion.dist?.shasum ?? null,
      verified_at: new Date().toISOString(),
    }), {
      verification: {
        provider: npmRegistryVerifyPlugin,
        status: 'visible',
        name: packageName,
        version: packageVersion,
        registry_url: registryUrl,
      },
    }, 'verified npm package visibility');
  },
};

const s3ManifestPublisher: PluginHandler = {
  async publish(request) {
    if (request.dry_run) {
      return okResponse({}, {
        publication: {
          provider: s3ManifestPublishPlugin,
          status: 'dry-run',
        },
      }, 's3 manifest publication dry-run');
    }

    throw new Error('builtin:s3-manifest-publish is reserved for a future implementation; remove it from artifact_publishers or provide an external plugin');
  },

  async verify(request) {
    if (request.dry_run) {
      return okResponse({}, {
        verification: {
          provider: s3ManifestPublishPlugin,
          status: 'dry-run',
        },
      }, 's3 manifest verification dry-run');
    }

    throw new Error('builtin:s3-manifest-publish verification is reserved for a future implementation; remove it from artifact_publishers or provide an external plugin');
  },
};

export const builtinArtifactPublisherHandlers: ArtifactPublisherHandlers = {
  [githubReleaseAssetsPlugin]: githubReleaseAssetsPublisher,
  [npmRegistryVerifyPlugin]: npmRegistryVerifier,
  [s3ManifestPublishPlugin]: s3ManifestPublisher,
};

interface ArtifactPublisherHandlers {
  [pluginRef: string]: PluginHandler;
}

async function readGitHubReleaseByTag(client: ReturnType<typeof createGitHubClient>, tag: string): Promise<GitHubReleaseForAssets> {
  const release = await client.requestJson<GitHubReleaseForAssets>({
    method: 'GET',
    path: `/repos/${client.repository.owner}/${client.repository.name}/releases/tags/${encodeURIComponent(tag)}`,
  });

  if (!release) {
    throw new Error(`GitHub Release ${tag} returned no response body`);
  }
  return release;
}

async function listGitHubReleaseAssets(client: ReturnType<typeof createGitHubClient>, releaseId: number): Promise<GitHubReleaseAsset[]> {
  return await client.requestJson<GitHubReleaseAsset[]>({
    method: 'GET',
    path: `/repos/${client.repository.owner}/${client.repository.name}/releases/${releaseId}/assets?per_page=100`,
  }) ?? [];
}

async function fetchNpmPackageVersion(registryUrl: string, packageName: string, packageVersion: string): Promise<NpmRegistryPackageVersion> {
  const url = `${registryUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`npm package ${packageName}@${packageVersion} is not visible at ${registryUrl} (HTTP ${response.status})`);
  }

  const parsed: unknown = await response.json();
  return readNpmPackageVersion(parsed, packageName, packageVersion);
}

function readNpmPackageVersion(value: unknown, packageName: string, packageVersion: string): NpmRegistryPackageVersion {
  if (!isObject(value)) {
    throw new Error(`npm registry returned an invalid package document for ${packageName}@${packageVersion}`);
  }

  const dist = isObject(value.dist) ? value.dist : {};
  return {
    name: readString(value.name),
    version: readString(value.version),
    dist: {
      tarball: readString(dist.tarball),
      shasum: readString(dist.shasum),
      integrity: readString(dist.integrity),
    },
  };
}

function appendArtifactPatch(request: PluginRequest, artifact: JsonObject): JsonObject {
  return {
    artifacts: [
      ...(request.release?.artifacts ?? []),
      artifact,
    ],
  };
}

function appendPackagePatch(request: PluginRequest, packageRecord: JsonObject): JsonObject {
  return {
    packages: [
      ...(request.release?.packages ?? []),
      packageRecord,
    ],
  };
}

function toReleaseAssetJson(asset: GitHubReleaseAsset): JsonObject {
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    state: asset.state,
    url: asset.browser_download_url,
    content_type: asset.content_type ?? null,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(config: unknown, keys: string[]): string[] {
  if (!isObject(config)) {
    return [];
  }

  for (const key of keys) {
    const value = config[key];
    if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string' && item.length > 0)) {
      return value;
    }
  }
  return [];
}

function readStringOption(config: unknown, keys: string[]): string | undefined {
  if (!isObject(config)) {
    return undefined;
  }

  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeRegistryUrl(value: string): string {
  if (!URL.canParse(value)) {
    throw new Error(`invalid npm registry URL ${value}`);
  }

  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') {
    throw new Error(`npm registry URL must use https: ${value}`);
  }
  return value.replace(/\/$/, '');
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
