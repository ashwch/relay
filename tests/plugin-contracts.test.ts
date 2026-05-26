// Tests for the plugin contract enforcement layer.
//
// These tests verify that the framework rejects invalid plugin states before
// they can affect the shared release document:
//
// 1. Manifest validation — hooks must match the declared plugin type
//    (e.g. a provider cannot claim a 'notify' hook)
//
// 2. Response shape validation — plugin responses must include all required
//    top-level fields (release_patch, outputs)
//
// 3. JSON-safety validation — responses must not contain non-JSON-safe
//    values such as NaN, functions, symbols, or circular references
//
// 4. Size-limit validation — oversized responses are rejected before they
//    can become hidden payload channels
//
// 5. Hook declaration enforcement — a handler that implements a hook the
//    manifest does not declare is rejected at call time
//
// Visual model of what these tests protect:
//
//   plugin manifest + handler
//           ↓
//   contract validation (this layer)
//           ↓
//   safe plugin execution
//
// The baseManifest fixture is intentionally a complete, valid manifest. Each
// test overrides only the fields it needs to produce a specific failure.

import { describe, expect, it } from 'vitest';

import { PluginExecutionError, runPluginHook } from '../src/core/orchestration/phase-runner.js';
import { validateManifest, PluginManifestError } from '../src/core/plugins/manifest.js';
import { PluginResponseValidationError } from '../src/core/plugins/response-validation.js';
import type { PluginManifest } from '../src/core/plugins/manifest.js';
import type { PluginHandler, PluginResponse } from '../src/core/plugins/request-response.js';

const oversizedPayloadLength = 300_000;

const baseManifest: PluginManifest = {
  api_version: 'release-framework.plugin/v1',
  name: 'test:plugin',
  type: 'provider',
  plugin_version: '1.0.0',
  plugin_api_version: 1,
  framework_version_range: '^0.1.0',
  entrypoint: {
    kind: 'builtin',
    handler: 'test.handler',
  },
  capabilities: ['normalize'],
  hooks: ['normalize'],
  supported_release_modes: ['framework-managed'],
  config_schema: null,
  required_inputs: [],
  required_secrets: [],
  optional_secrets: [],
  permissions: {},
  supports: {
    dry_run: true,
    local: true,
  },
  outputs: [],
  trust: {
    level: 'builtin',
    allow_in_ci: true,
  },
};

describe('plugin contracts', () => {
  it('rejects manifests with hooks that do not match the plugin type', () => {
    expect(() => validateManifest({
      ...baseManifest,
      hooks: ['notify'],
    })).toThrowError(PluginManifestError);
  });

  it('rejects plugin responses with invalid shapes', async () => {
    const handler: PluginHandler = {
      async normalize() {
        return malformedResponseMissingOutputs();
      },
    };

    await expect(runNormalizeHook(handler)).rejects.toThrowError(PluginResponseValidationError);
  });

  it('rejects plugin responses with non-JSON-safe values', async () => {
    const handler: PluginHandler = {
      async normalize() {
        return malformedResponseWithNonJsonNumber();
      },
    };

    await expect(runNormalizeHook(handler)).rejects.toThrowError(PluginResponseValidationError);
  });

  it('rejects oversized plugin responses', async () => {
    const handler: PluginHandler = {
      async normalize() {
        return {
          status: 'ok',
          release_patch: {},
          outputs: {
            payload: 'x'.repeat(oversizedPayloadLength),
          },
          logs: [],
        };
      },
    };

    await expect(runNormalizeHook(handler)).rejects.toThrowError(PluginResponseValidationError);
  });

  it('fails if a plugin handler exists but the manifest does not declare the hook', async () => {
    const handler: PluginHandler = {
      async notify() {
        return {
          status: 'noop',
          release_patch: {},
          outputs: {},
          logs: [],
        };
      },
    };

    await expect(runPluginHook({
      manifest: {
        ...baseManifest,
        type: 'notifier',
        hooks: ['render'],
      },
      handler,
      hook: 'notify',
      dryRun: true,
      pluginConfig: {},
      release: null,
      args: {},
      env: {},
      workspaceRoot: process.cwd(),
    })).rejects.toThrowError(PluginExecutionError);
  });
});

async function runNormalizeHook(handler: PluginHandler): Promise<Awaited<ReturnType<typeof runPluginHook>>> {
  return await runPluginHook({
    manifest: baseManifest,
    handler,
    hook: 'normalize',
    dryRun: true,
    pluginConfig: {},
    release: null,
    args: {},
    env: {},
    workspaceRoot: process.cwd(),
  });
}

function malformedResponseMissingOutputs(): PluginResponse {
  return JSON.parse('{"status":"ok","release_patch":{},"logs":[]}');
}

function malformedResponseWithNonJsonNumber(): PluginResponse {
  const validResponse = {
    status: 'ok',
    release_patch: {},
    outputs: {},
    logs: [],
  } satisfies PluginResponse;

  return {
    ...validResponse,
    outputs: {
      payload: Number.NaN,
    },
  };
}
