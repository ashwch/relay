import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LoadedConfig, ReleaseConfig } from '../src/core/config/types.js';
import { runPluginHook } from '../src/core/orchestration/phase-runner.js';
import { validatePluginConfig, PluginConfigValidationError } from '../src/core/plugins/config-validation.js';
import { loadPlugin } from '../src/core/plugins/loader.js';
import type { PluginManifest } from '../src/core/plugins/manifest.js';
import { PluginResponseValidationError } from '../src/core/plugins/response-validation.js';
import { ExternalPluginExecutionError } from '../src/core/plugins/subprocess-runner.js';
import type { StringMap } from '../src/core/types/runtime.js';
import { createBaseReleaseDocument } from '../src/plugins/builtin/providers/shared.js';

// These tests are intentionally end-to-end at the subprocess boundary.
//
// Why generate tiny temporary plugins instead of mocking the runtime?
// Because the most important questions here are process-boundary questions:
//
//   does stdin reach the plugin?
//   does stdout come back as JSON?
//   do timeouts and size limits really fire?
//   does the env/secrets boundary behave the way the docs claim?
//   does plugin config fail early before hook execution?
//
// Small generated plugin directories give us realistic coverage without needing
// checked-in fixture packages.
const tempDirs: string[] = [];
const oversizedPayloadLength = 300_000;
const timeoutPluginDelayMs = 200;
const shortHookTimeoutMs = 50;
const successPluginRef = 'path:./plugin-success';
const invalidJsonPluginRef = 'path:./plugin-invalid-json';
const oversizedPluginRef = 'path:./plugin-oversized';
const timeoutPluginRef = 'path:./plugin-timeout';
const blockedPluginRef = 'path:./plugin-blocked';
const badShapePluginRef = 'path:./plugin-bad-shape';
const invalidConfigPluginRef = 'path:./plugin-invalid-config';
const escapedSchemaPluginRef = 'path:./plugin-escaped-schema';
const symlinkedSchemaPluginRef = 'path:./plugin-symlinked-schema';
const symlinkedHandlerPluginRef = 'path:./plugin-symlinked-handler';

describe('external plugin subprocess runtime', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('runs an allowlisted path plugin in a subprocess', async () => {
    const loaded = createLoadedConfig(successPluginRef);
    writePlugin(loaded.dir, 'plugin-success', createManifest('test:success-plugin', 'metadata_enricher', ['enrich']), `
import process from 'node:process';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    status: 'ok',
    release_patch: {
      extensions: {
        external_plugin: {
          ran: true,
        },
      },
    },
    outputs: {
      input_env_keys: Object.keys(request.inputs.env),
      has_process_secret: Boolean(process.env.TOP_SECRET),
    },
    logs: [],
  }));
});
`);

    const result = await runExternalEnrichHook(loaded, successPluginRef, {
      TOP_SECRET: 'do-not-leak',
    });

    expect(result.release?.extensions.external_plugin).toEqual({ ran: true });
    expect(result.response.outputs.input_env_keys).toEqual([]);
    expect(result.response.outputs.has_process_secret).toBe(false);
  });

  it('rejects invalid JSON from an external plugin', async () => {
    const loaded = createLoadedConfig(invalidJsonPluginRef);
    writePlugin(loaded.dir, 'plugin-invalid-json', createManifest('test:invalid-json-plugin', 'metadata_enricher', ['enrich']), `
process.stdout.write('not json');
`);

    await expect(runExternalEnrichHook(loaded, invalidJsonPluginRef)).rejects.toThrowError('returned invalid JSON');
  });

  it('rejects oversized stdout from an external plugin', async () => {
    const loaded = createLoadedConfig(oversizedPluginRef);
    writePlugin(loaded.dir, 'plugin-oversized', createManifest('test:oversized-plugin', 'metadata_enricher', ['enrich']), `
process.stdout.write(JSON.stringify({
  status: 'ok',
  release_patch: {},
  outputs: {
    payload: 'x'.repeat(${oversizedPayloadLength}),
  },
  logs: [],
}));
`);

    await expect(runExternalEnrichHook(loaded, oversizedPluginRef)).rejects.toThrowError('exceeded stdout limit');
  });

  it('rejects timed out external plugins', async () => {
    const loaded = createLoadedConfig(timeoutPluginRef);
    writePlugin(loaded.dir, 'plugin-timeout', createManifest('test:timeout-plugin', 'metadata_enricher', ['enrich']), `
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    status: 'ok',
    release_patch: {},
    outputs: {},
    logs: [],
  }));
}, ${timeoutPluginDelayMs});
`);

    await expect(runExternalEnrichHook(loaded, timeoutPluginRef, {}, shortHookTimeoutMs)).rejects.toThrowError('timed out');
  });

  it('rejects non-allowlisted external plugins before execution', () => {
    const loaded = createLoadedConfig('path:./different-plugin');
    writePlugin(loaded.dir, 'plugin-blocked', createManifest('test:blocked-plugin', 'metadata_enricher', ['enrich']), `
process.stdout.write(JSON.stringify({ status: 'ok', release_patch: {}, outputs: {}, logs: [] }));
`);

    expect(() => loadPlugin(loaded, blockedPluginRef, 'metadata_enricher')).toThrowError('not allowlisted');
  });

  it('still validates external plugin response shape after subprocess execution', async () => {
    const loaded = createLoadedConfig(badShapePluginRef);
    writePlugin(loaded.dir, 'plugin-bad-shape', createManifest('test:bad-shape-plugin', 'metadata_enricher', ['enrich']), `
process.stdout.write(JSON.stringify({
  status: 'ok',
  release_patch: {},
  logs: [],
}));
`);

    await expect(runExternalEnrichHook(loaded, badShapePluginRef)).rejects.toThrowError(PluginResponseValidationError);
  });

  it('rejects invalid plugin config before external execution', async () => {
    const loaded = createLoadedConfig(invalidConfigPluginRef, {
      plugin_config: {
        [invalidConfigPluginRef]: {
          summary_label: 42,
        },
      },
    });
    writePlugin(
      loaded.dir,
      'plugin-invalid-config',
      createManifest('test:invalid-config-plugin', 'metadata_enricher', ['enrich'], 'config.schema.json'),
      `
process.stdout.write(JSON.stringify({ status: 'ok', release_patch: {}, outputs: {}, logs: [] }));
`,
      {
        'config.schema.json': JSON.stringify({
          type: 'object',
          properties: {
            summary_label: {
              type: 'string',
            },
          },
          additionalProperties: false,
        }, null, 2),
      },
    );

    await expect(runExternalEnrichHook(loaded, invalidConfigPluginRef)).rejects.toThrowError(PluginConfigValidationError);
  });

  it('rejects config schemas that escape the plugin root', () => {
    const loaded = createLoadedConfig(escapedSchemaPluginRef);
    writePlugin(
      loaded.dir,
      'plugin-escaped-schema',
      createManifest('test:escaped-schema-plugin', 'metadata_enricher', ['enrich'], '../outside.schema.json'),
      `
process.stdout.write(JSON.stringify({ status: 'ok', release_patch: {}, outputs: {}, logs: [] }));
`,
    );

    const plugin = loadPlugin(loaded, escapedSchemaPluginRef, 'metadata_enricher');
    expect(() => validatePluginConfig(plugin, {})).toThrowError('config_schema must stay inside plugin root');
  });

  it('rejects symlinked config schemas that escape the plugin root', () => {
    const loaded = createLoadedConfig(symlinkedSchemaPluginRef);
    writePlugin(
      loaded.dir,
      'plugin-symlinked-schema',
      createManifest('test:symlinked-schema-plugin', 'metadata_enricher', ['enrich'], 'config.schema.json'),
      `
process.stdout.write(JSON.stringify({ status: 'ok', release_patch: {}, outputs: {}, logs: [] }));
`,
    );

    const outsideSchemaPath = path.join(loaded.dir, 'outside.schema.json');
    fs.writeFileSync(outsideSchemaPath, JSON.stringify({ type: 'object' }, null, 2), 'utf8');
    fs.rmSync(path.join(loaded.dir, 'plugin-symlinked-schema', 'config.schema.json'), { force: true });
    fs.symlinkSync(outsideSchemaPath, path.join(loaded.dir, 'plugin-symlinked-schema', 'config.schema.json'));

    const plugin = loadPlugin(loaded, symlinkedSchemaPluginRef, 'metadata_enricher');
    expect(() => validatePluginConfig(plugin, {})).toThrowError('config_schema must stay inside plugin root');
  });

  it('rejects symlinked handlers that escape the plugin root', async () => {
    const loaded = createLoadedConfig(symlinkedHandlerPluginRef);
    writePlugin(
      loaded.dir,
      'plugin-symlinked-handler',
      createManifest('test:symlinked-handler-plugin', 'metadata_enricher', ['enrich']),
      `
process.stdout.write(JSON.stringify({ status: 'ok', release_patch: {}, outputs: {}, logs: [] }));
`,
    );

    const outsideHandlerPath = path.join(loaded.dir, 'outside-handler.mjs');
    fs.writeFileSync(outsideHandlerPath, 'process.stdout.write(JSON.stringify({ status: "ok", release_patch: {}, outputs: {}, logs: [] }));\n', 'utf8');
    fs.rmSync(path.join(loaded.dir, 'plugin-symlinked-handler', 'index.mjs'), { force: true });
    fs.symlinkSync(outsideHandlerPath, path.join(loaded.dir, 'plugin-symlinked-handler', 'index.mjs'));

    await expect(runExternalEnrichHook(loaded, symlinkedHandlerPluginRef)).rejects.toThrowError(ExternalPluginExecutionError);
    await expect(runExternalEnrichHook(loaded, symlinkedHandlerPluginRef)).rejects.toThrowError('handler must stay inside plugin root');
  });
});

function createLoadedConfig(pluginRef: string, overrides: Partial<ReleaseConfig> = {}): LoadedConfig {
  // Keep each test isolated in its own temp workspace so plugin allowlists,
  // manifests, and handler files are easy to reason about.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plugin-'));
  tempDirs.push(tempDir);
  return {
    path: path.join(tempDir, 'relay.yml'),
    dir: tempDir,
    config: createTestConfig(pluginRef, overrides),
  };
}

// Minimal release config that allowlists exactly one plugin and sets neutral
// defaults for all other fields. Each test can override specific fields via
// the overrides parameter.
function createTestConfig(pluginRef: string, overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    api_version: 1,
    product_name: 'Example Service',
    release_profile: 'deploy-release',
    release_mode: 'framework-managed',
    provider_plugin: 'builtin:generic-env',
    profile_plugin: 'builtin:deploy-release',
    tool_plugin: null,
    artifact_publishers: [],
    notifiers: [],
    metadata_enrichers: [pluginRef],
    plugin_allowlist: [pluginRef],
    allow_local_plugins: true,
    stable_branches: ['main'],
    version_source: {
      type: 'date-sha',
    },
    tag_template: 'release-{version}',
    notes_source: {
      type: 'static',
    },
    plugin_config: {},
    ...overrides,
  };
}

// Minimal manifest factory. Each test customizes the fields it cares about
// (type, hooks, configSchema) and relies on sensible defaults for the rest.
function createManifest(
  name: string,
  type: PluginManifest['type'],
  hooks: PluginManifest['hooks'],
  configSchema: string | null = null,
): PluginManifest {
  return {
    api_version: 'relay.plugin/v1',
    name,
    type,
    plugin_version: '1.0.0',
    plugin_api_version: 1,
    framework_version_range: '^0.1.0',
    entrypoint: {
      kind: 'module',
      handler: 'index.mjs',
    },
    capabilities: hooks,
    hooks,
    supported_release_modes: ['framework-managed'],
    config_schema: configSchema,
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
      level: 'external-allowlisted',
      allow_in_ci: true,
    },
  };
}

function writePlugin(
  workspaceDir: string,
  directoryName: string,
  manifest: PluginManifest,
  handlerSource: string,
  extraFiles: StringMap = {},
): void {
  // Write the smallest possible real plugin layout:
  //
  //   <plugin dir>/plugin-manifest.json
  //   <plugin dir>/index.mjs
  //
  // That mirrors the runtime's actual expectations and keeps the tests visual.
  const pluginDir = path.join(workspaceDir, directoryName);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), handlerSource.trimStart(), 'utf8');
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(pluginDir, relativePath), content, 'utf8');
  }
}

async function runExternalEnrichHook(
  loaded: LoadedConfig,
  pluginRef: string,
  env: StringMap = {},
  hookTimeoutMs?: number,
): Promise<Awaited<ReturnType<typeof runPluginHook>>> {
  // Shared test harness for the common subprocess case in this file:
  //
  //   external metadata enricher
  //     ↓
  //   config validation
  //     ↓
  //   runPluginHook(...)
  //
  // Keeping this helper small avoids repeating the same trust-boundary setup in
  // every test while still leaving each case easy to read.
  const plugin = loadPlugin(loaded, pluginRef, 'metadata_enricher');
  const pluginConfig = validatePluginConfig(plugin, loaded.config.plugin_config?.[pluginRef] ?? {});
  return await runPluginHook({
    manifest: plugin.manifest,
    handler: plugin.handler,
    hook: 'enrich',
    dryRun: true,
    pluginConfig,
    release: createTestRelease(),
    args: {},
    env,
    workspaceRoot: loaded.dir,
    pluginRoot: plugin.rootDir,
    hookTimeoutMs,
  });
}

// Neutral sample release document for non-normalize hooks.
//
// Uses the same placeholder data as the validate-plugin sample defaults so
// test assertions stay consistent across test files.
function createTestRelease(): ReturnType<typeof createBaseReleaseDocument> {
  return createBaseReleaseDocument(createTestConfig('path:./unused-plugin'), {
    providerPlugin: 'builtin:generic-env',
    trigger: 'manual',
    ciSystem: 'generic-env',
    eventName: 'manual',
    receivedAt: '2026-05-22T12:00:00.000Z',
    owner: 'ExampleOrg',
    repo: 'web-app',
    sha: '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c',
    ref: 'refs/heads/main',
    refName: 'main',
    refType: 'branch',
    stableBranch: true,
    dryRun: true,
    workflowUrl: null,
    completionStatus: 'completed',
    workspaceRoot: process.cwd(),
  });
}
