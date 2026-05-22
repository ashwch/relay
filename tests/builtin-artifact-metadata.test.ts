import { afterEach, describe, expect, it, vi } from 'vitest';

import { builtinArtifactPublisherHandlers } from '../src/plugins/builtin/artifact-publishers/index.js';
import { builtinMetadataEnricherHandlers } from '../src/plugins/builtin/metadata-enrichers/index.js';
import { buildNormalizedRelease, fixtureReleaseTag } from './helpers/normalized-release.js';
import type { PluginRequest } from '../src/core/plugins/request-response.js';
import type { JsonObject } from '../src/core/types/json.js';
import type { EnvMap } from '../src/core/types/runtime.js';

const repository = 'ExampleOrg/web-app';
const release = buildNormalizedRelease();

describe('built-in artifact publishers and metadata enrichers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses pull request references from the release body', async () => {
    const handler = readMetadataEnricher('builtin:github-release-body-pr-parser');
    const response = await handler.enrich?.(buildRequest({
      hook: 'enrich',
      release: buildNormalizedRelease({
        release: {
          ...release.release,
          body: 'Changes from PR #12, pull/34, and duplicate #12.',
        },
      }),
    }));

    expect(response?.release_patch).toMatchObject({
      pull_requests: [
        {
          number: 12,
          url: `https://github.com/${repository}/pull/12`,
        },
        {
          number: 34,
          url: `https://github.com/${repository}/pull/34`,
        },
      ],
    });
  });

  it('does not call GitHub for associated PR enrichment in dry-run mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const handler = readMetadataEnricher('builtin:github-associated-prs');
    const response = await handler.enrich?.(buildRequest({
      hook: 'enrich',
      dryRun: true,
    }));

    expect(response?.outputs).toMatchObject({
      provider: 'builtin:github-associated-prs',
      status: 'dry-run',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies required GitHub Release assets', async () => {
    const fetchMock = mockFetchResponses([
      {
        method: 'GET',
        url: `https://api.github.com/repos/${repository}/releases/tags/${fixtureReleaseTag}`,
        status: 200,
        body: {
          id: 91,
          html_url: `https://github.com/${repository}/releases/tag/${fixtureReleaseTag}`,
          tag_name: fixtureReleaseTag,
        },
      },
      {
        method: 'GET',
        url: `https://api.github.com/repos/${repository}/releases/91/assets?per_page=100`,
        status: 200,
        body: [
          {
            id: 1001,
            name: 'web-app.zip',
            size: 123,
            state: 'uploaded',
            browser_download_url: `https://github.com/${repository}/releases/download/${fixtureReleaseTag}/web-app.zip`,
            content_type: 'application/zip',
          },
        ],
      },
    ]);

    const handler = readArtifactPublisher('builtin:github-release-assets');
    const response = await handler.verify?.(buildRequest({
      hook: 'verify',
      config: {
        required_assets: ['web-app.zip'],
      },
      env: {
        GITHUB_TOKEN: 'test-token',
      },
    }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response?.release_patch).toMatchObject({
      artifacts: [
        {
          provider: 'builtin:github-release-assets',
          status: 'verified',
        },
      ],
    });
  });

  it('allows reserved S3 manifest publishing to complete both dry-run hooks', async () => {
    const handler = readArtifactPublisher('builtin:s3-manifest-publish');
    const publishResponse = await handler.publish?.(buildRequest({
      hook: 'publish',
      dryRun: true,
    }));
    const verifyResponse = await handler.verify?.(buildRequest({
      hook: 'verify',
      dryRun: true,
    }));

    expect(publishResponse?.outputs).toMatchObject({
      publication: {
        provider: 'builtin:s3-manifest-publish',
        status: 'dry-run',
      },
    });
    expect(verifyResponse?.outputs).toMatchObject({
      verification: {
        provider: 'builtin:s3-manifest-publish',
        status: 'dry-run',
      },
    });
  });

  it('verifies npm package visibility', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      name: '@example/web-app',
      version: release.release.version,
      dist: {
        tarball: 'https://registry.npmjs.org/@example/web-app/-/web-app.tgz',
        integrity: 'sha512-test',
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const handler = readArtifactPublisher('builtin:npm-registry-verify');
    const response = await handler.verify?.(buildRequest({
      hook: 'verify',
      config: {
        name: '@example/web-app',
      },
    }));

    expect(fetchMock).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${encodeURIComponent('@example/web-app')}/${encodeURIComponent(release.release.version)}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(response?.release_patch).toMatchObject({
      packages: [
        {
          provider: 'builtin:npm-registry-verify',
          status: 'visible',
          name: '@example/web-app',
        },
      ],
    });
  });
});

interface MockFetchResponse {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  status: number;
  body: JsonObject | JsonObject[];
}

function readArtifactPublisher(pluginRef: string) {
  const handler = builtinArtifactPublisherHandlers[pluginRef];
  if (!handler) {
    throw new Error(`missing artifact publisher ${pluginRef}`);
  }
  return handler;
}

function readMetadataEnricher(pluginRef: string) {
  const handler = builtinMetadataEnricherHandlers[pluginRef];
  if (!handler) {
    throw new Error(`missing metadata enricher ${pluginRef}`);
  }
  return handler;
}

function buildRequest(options: {
  hook: 'publish' | 'verify' | 'enrich';
  config?: JsonObject;
  env?: EnvMap;
  release?: typeof release;
  dryRun?: boolean;
}): PluginRequest {
  return {
    plugin_api_version: 1,
    hook: options.hook,
    dry_run: options.dryRun ?? false,
    plugin: {
      name: 'builtin:test',
      version: '1.0.0',
    },
    config: options.config ?? {},
    release: options.release ?? release,
    inputs: {
      env: options.env ?? {},
      args: {},
      files: {},
    },
    secrets: {},
    workspace: {
      root: process.cwd(),
    },
  };
}

function mockFetchResponses(responses: MockFetchResponse[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const next = responses.shift();
    expect(next).toBeDefined();
    expect(String(input)).toBe(next?.url);
    expect(init?.method ?? 'GET').toBe(next?.method);

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
