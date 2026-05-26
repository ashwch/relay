import fs from 'node:fs';
import path from 'node:path';

import type { LoadedConfig, ReleaseConfig } from '../../core/config/types.js';
import { loadPluginForValidation } from '../../core/plugins/loader.js';
import { PluginConfigValidationError, validatePluginConfig } from '../../core/plugins/config-validation.js';
import { runPluginHook } from '../../core/orchestration/phase-runner.js';
import { validateNormalizedRelease } from '../../core/release-json/invariants.js';
import type { NormalizedRelease } from '../../core/release-json/schema.js';
import { createBaseReleaseDocument } from '../../plugins/builtin/providers/shared.js';
import type { PluginManifest } from '../../core/plugins/manifest.js';
import type { HookName, PluginRequest } from '../../core/plugins/request-response.js';
import { readJsonObjectFile } from '../../core/io/files.js';
import type { JsonValue } from '../../core/types/json.js';
import type { EnvMap, RuntimeArgs, StringMap, UnknownMap } from '../../core/types/runtime.js';

// These sample values exist for one reason:
// `validate-plugin` should be useful before a plugin author has a full real
// release run wired up.
//
// Visual model:
//
//   plugin author has manifest + handler
//                ↓
//        framework builds sample request
//                ↓
//        author validates contract locally
//
// The values below are intentionally neutral placeholders. They make dry-run
// hook execution deterministic without pretending to be real production data.
const sampleRepositoryOwner = 'ExampleOrg';
const sampleRepositoryName = 'web-app';
const sampleReleaseSha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c';
const sampleReleaseRef = 'refs/heads/main';
const sampleReleaseRefName = 'main';
const sampleReceivedAt = '2026-05-22T12:00:00.000Z';
const sampleReleaseProfile = 'deploy-release';
const sampleProviderPlugin = 'builtin:generic-env';
const sampleProfilePlugin = 'builtin:deploy-release';
const sampleTagTemplate = 'release-{version}';
const sampleVersionSourceType = 'date-sha';
const sampleNotesSourceType = 'static';
const sampleWorkflowUrl = 'https://example.invalid/workflows/release';
const sampleHookTimeoutMs = 5_000;
const sampleSecretPrefix = 'example-secret-for-';

export interface ValidatePluginCommandOptions {
  plugin: string;
  plugin_config_json?: string;
  request_json?: string[];
  request_json_dir?: string;
  hook?: string;
  json?: boolean;
  no_exec?: boolean;
}

// Small structured result records for the author-facing validation loop.
//
// Why keep these explicit?
// Because `validate-plugin` serves two audiences at once:
// - humans reading the default terminal output
// - tools/scripts reading `--json` output
//
// A small named result shape makes both output styles easier to keep aligned.
interface ValidatePluginStep {
  name: string;
  label: string;
  status: 'ok';
  details?: string[];
}

interface ValidatePluginHookResult {
  hook: HookName;
  status: 'ok';
  details: {
    response_status: string;
  };
}

export class ValidatePluginCommandError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

interface ValidatePluginResult {
  status: 'ok';
  no_exec: boolean;
  plugin: {
    ref: string;
    name: string;
    type: string;
    hooks: HookName[];
    config_schema: string | null;
  };
  steps: ValidatePluginStep[];
  hook_results: ValidatePluginHookResult[];
}

interface ValidatePluginRequestFixture {
  hook: HookName;
  dry_run: boolean;
  config: unknown;
  release: NormalizedRelease | null;
  inputs: PluginRequest['inputs'];
  secrets: StringMap;
  workspace: PluginRequest['workspace'];
}

interface ValidationRunPlan {
  hook: HookName;
  dry_run: boolean;
  plugin_config: unknown;
  release: NormalizedRelease | null;
  inputs: PluginRequest['inputs'];
  workspace_root: string;
  secrets: StringMap;
  request_source?: string;
}

/**
 * Validate one plugin as a plugin author would.
 *
 * Visual model:
 *
 *   plugin ref
 *      ↓ resolve + load manifest
 *   static contract checks
 *      ↓ optional config schema validation
 *   optional sample request fixture load
 *      ↓ one run plan per hook or fixture
 *      ↓ optional dry-run hook execution
 *      ↓
 *   one author-facing result
 *
 * Why this command exists:
 * plugin authors need a fast local loop that catches manifest/config/runtime
 * problems before they wire the plugin into a larger release flow.
 *
 * The command is intentionally useful in three shapes:
 *
 *   one built-in sample request
 *      ↓ fastest first validation
 *
 *   one or more explicit request fixtures
 *      ↓ more realistic hook-specific validation
 *
 *   one fixture directory
 *      ↓ auto-match <hook>.request.json files for multi-hook plugins
 */
export async function runValidatePluginCommand(options: ValidatePluginCommandOptions): Promise<void> {
  assertValidatePluginOptions(options);

  const loaded = createValidationLoadedConfig(options.plugin);
  const plugin = loadPluginForValidation(loaded, options.plugin);
  const requestJsonPaths = resolveRequestJsonPaths(options, plugin.manifest.hooks);
  const requestFixtures = readRequestFixtures(requestJsonPaths);

  // Validate hook declaration before checking hook/fixture compatibility.
  //
  // Why this order?
  // Because
  //
  //   --hook notify --request-json enrich.request.json
  //
  // on an enrich-only plugin should first fail as
  //
  //   "notify is not declared by the plugin"
  //
  // rather than the less fundamental
  //
  //   "notify does not match fixture hook enrich"
  //
  // The declaration error is the root problem; fixture mismatch is secondary.
  const requestedHooks = resolveValidationHooks(plugin.manifest.hooks, options.hook, requestFixtures);
  assertCompatibleHookSelection(options.hook, requestFixtures, requestJsonPaths);
  const noExec = options.no_exec ?? false;
  const result = buildInitialValidatePluginResult(plugin.pluginRef, plugin.manifest, noExec);

  const plans = buildValidationRunPlans(plugin.manifest, plugin.pluginRef, plugin, options.plugin_config_json, requestFixtures, requestJsonPaths, requestedHooks, result.steps);

  if (requestFixtures.length === 0 && plugin.manifest.hooks.length > 1) {
    result.steps.push(buildFixtureSuggestionStep(plugin.manifest.hooks));
  }

  if (!noExec) {
    for (const plan of plans) {
      try {
        const execution = await runPluginHook({
          manifest: plugin.manifest,
          handler: plugin.handler,
          hook: plan.hook,
          dryRun: plan.dry_run,
          pluginConfig: plan.plugin_config,
          release: plan.release,
          args: plan.inputs.args,
          env: plan.inputs.env,
          files: plan.inputs.files,
          workspaceRoot: plan.workspace_root,
          pluginRoot: plugin.rootDir,
          hookTimeoutMs: sampleHookTimeoutMs,
          secrets: plan.secrets,
        });

        result.hook_results.push({
          hook: plan.hook,
          status: 'ok',
          details: {
            response_status: execution.response.status,
          },
        });
      } catch (error) {
        throw buildValidatePluginExecutionError(plugin.pluginRef, plan.hook, error, plan.request_source);
      }
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(renderHumanResult(result));
}

// Render the default human-facing summary.
//
// Visual goal:
//
//   what plugin was validated?
//   what static checks passed?
//   what hook execution checks passed?
//   what should the author try next?
//
// The JSON form is better for tooling, but this form is optimized for a plugin
// author iterating in a terminal.
//
// Important design choice:
// we keep author guidance in the same output as the pass/fail summary.
// A validation command is most useful when it does not just say "ok" or
// "error", but also points the author at the next concrete command or fixture.
function renderHumanResult(result: ValidatePluginResult): string {
  const lines = [
    `Plugin: ${result.plugin.ref}`,
    `Name: ${result.plugin.name}`,
    `Type: ${result.plugin.type}`,
    `Hooks: ${result.plugin.hooks.join(', ')}`,
    `Config schema: ${result.plugin.config_schema ?? 'none'}`,
    '',
    'Static checks:',
    ...result.steps.map((step) => `  ✔ ${step.label}${step.details && step.details.length > 0 ? ` (${step.details.join('; ')})` : ''}`),
  ];

  if (result.no_exec) {
    lines.push(
      '',
      'Execution checks: skipped (--no-exec)',
      '',
      'next_step: rerun without --no-exec to validate dry-run hook execution',
    );
  } else {
    lines.push('', 'Execution checks:');
    lines.push(...result.hook_results.map((hookResult) => `  ✔ dry-run hook executed (hook=${hookResult.hook}; response_status=${hookResult.details.response_status})`));
  }

  return `${lines.join('\n')}\n`;
}

// `validate-plugin` needs just enough surrounding relay config to
// resolve plugin refs and, for provider plugins, to validate the full
// release-config-shaped `request.config` object.
function createValidationLoadedConfig(pluginRef: string): LoadedConfig {
  return {
    path: path.resolve(process.cwd(), 'validate-plugin.virtual.yml'),
    dir: process.cwd(),
    config: {
      api_version: 1,
      product_name: 'Plugin Validation Workspace',
      release_profile: sampleReleaseProfile,
      release_mode: 'framework-managed',
      provider_plugin: sampleProviderPlugin,
      profile_plugin: sampleProfilePlugin,
      tool_plugin: null,
      artifact_publishers: [],
      notifiers: [],
      metadata_enrichers: [],
      plugin_allowlist: [pluginRef],
      allow_local_plugins: true,
      stable_branches: [sampleReleaseRefName],
      version_source: {
        type: sampleVersionSourceType,
      },
      tag_template: sampleTagTemplate,
      notes_source: {
        type: sampleNotesSourceType,
      },
      plugin_config: {},
    },
  };
}

// Providers are special:
//
//   provider hook request.config -> full release config
//   other plugin request.config  -> plugin-local config object
//
// That distinction is important for DX. A provider author should not get a
// fake "plugin config is empty" error just because providers validate a
// different config surface than other plugin types.
function buildInitialValidatePluginResult(
  pluginRef: string,
  manifest: PluginManifest,
  noExec: boolean,
): ValidatePluginResult {
  return {
    status: 'ok',
    no_exec: noExec,
    plugin: {
      ref: pluginRef,
      name: manifest.name,
      type: manifest.type,
      hooks: manifest.hooks,
      config_schema: manifest.config_schema ?? null,
    },
    steps: [
      {
        name: 'plugin-resolved',
        label: 'plugin ref resolved',
        status: 'ok',
        details: [`ref=${pluginRef}`],
      },
      {
        name: 'manifest-loaded',
        label: 'manifest loaded',
        status: 'ok',
        details: [`type=${manifest.type}`, `hooks=${manifest.hooks.join(', ')}`],
      },
    ],
    hook_results: [],
  };
}

function buildValidationRunPlans(
  manifest: PluginManifest,
  pluginRef: string,
  loadedPlugin: ReturnType<typeof loadPluginForValidation>,
  pluginConfigJsonPath: string | undefined,
  requestFixtures: ValidatePluginRequestFixture[],
  requestJsonPaths: string[],
  requestedHooks: HookName[],
  steps: ValidatePluginStep[],
): ValidationRunPlan[] {
  if (requestFixtures.length === 0) {
    const configInput = readDefaultPluginConfigInput(manifest, pluginConfigJsonPath);
    const pluginConfig = validatePluginConfigForRun(loadedPlugin, pluginRef, configInput.source, configInput.value);
    steps.push(buildPluginConfigValidatedStep(manifest, configInput.source));

    return requestedHooks.map((hook) => ({
      hook,
      dry_run: true,
      plugin_config: pluginConfig,
      release: buildSampleReleaseForHook(hook),
      inputs: {
        env: {},
        args: buildSampleArgsForHook(hook),
        files: {},
      },
      workspace_root: process.cwd(),
      secrets: buildSampleSecrets(manifest.required_secrets, manifest.optional_secrets),
    }));
  }

  return requestFixtures.map((requestFixture, index) => {
    const requestSource = requestJsonPaths[index];
    const resolvedRequestSource = requestSource ? path.resolve(requestSource) : undefined;
    const configSource = `${resolvedRequestSource ?? 'request fixture'} (config field)`;
    const pluginConfig = validatePluginConfigForRun(loadedPlugin, pluginRef, configSource, requestFixture.config);

    steps.push(buildPluginConfigValidatedStep(manifest, configSource));
    if (requestSource) {
      steps.push(buildRequestFixtureStep(requestSource, requestFixture.hook));
    }

    return {
      hook: requestFixture.hook,
      dry_run: requestFixture.dry_run,
      plugin_config: pluginConfig,
      release: requestFixture.release,
      inputs: requestFixture.inputs,
      workspace_root: requestFixture.workspace.root,
      secrets: requestFixture.secrets,
      request_source: resolvedRequestSource,
    };
  });
}

function readDefaultPluginConfigInput(
  manifest: PluginManifest,
  pluginConfigJsonPath: string | undefined,
): {
  source: string;
  value: unknown;
} {
  if (pluginConfigJsonPath) {
    return {
      source: path.resolve(pluginConfigJsonPath),
      value: readJsonObjectFile(pluginConfigJsonPath),
    };
  }

  return manifest.type === 'provider'
    ? {
      source: 'built-in sample release config',
      value: buildSampleReleaseConfig(),
    }
    : {
      source: 'built-in default (empty config)',
      value: {},
    };
}

function validatePluginConfigForRun(
  loadedPlugin: ReturnType<typeof loadPluginForValidation>,
  pluginRef: string,
  configSource: string,
  value: unknown,
): unknown {
  try {
    return validatePluginConfig(loadedPlugin, value);
  } catch (error) {
    throw buildValidatePluginConfigError(pluginRef, configSource, error);
  }
}

function buildPluginConfigValidatedStep(manifest: PluginManifest, configSource: string): ValidatePluginStep {
  return {
    name: 'plugin-config-validated',
    label: 'plugin config validated',
    status: 'ok',
    details: [
      manifest.config_schema
        ? `schema=${manifest.config_schema}`
        : 'schema=none',
      `config_kind=${manifest.type === 'provider' ? 'release-config' : 'plugin-config'}`,
      `config_source=${configSource}`,
    ],
  };
}

// Resolve which hooks to validate.
//
// Selection rules:
//
//   explicit --hook         -> validate exactly that hook
//   request fixture hook    -> validate the fixture's hook
//   neither provided        -> validate all declared hooks
//
// Why prefer the fixture hook when present?
// Because a request fixture is usually shaped for one concrete hook, and
// validating unrelated hooks against that same request would be misleading.
function resolveValidationHooks(availableHooks: HookName[], requestedHook: string | undefined, requestFixtures: ValidatePluginRequestFixture[]): HookName[] {
  if (requestedHook) {
    if (!isHookName(requestedHook) || !availableHooks.includes(requestedHook)) {
      throw new ValidatePluginCommandError(`requested hook ${requestedHook} is not declared by the plugin`, [
        `declared_hooks=${availableHooks.join(', ')}`,
        'next_step=choose one of the declared hooks or omit --hook to validate all declared hooks',
      ]);
    }
    return [requestedHook];
  }

  if (requestFixtures.length > 0) {
    const fixtureHooks = requestFixtures.map((fixture) => fixture.hook);
    const undeclaredFixtureHook = fixtureHooks.find((hook) => !availableHooks.includes(hook));
    if (undeclaredFixtureHook) {
      throw new ValidatePluginCommandError(`request fixture hook ${undeclaredFixtureHook} is not declared by the plugin`, [
        `declared_hooks=${availableHooks.join(', ')}`,
        'next_step=choose a fixture whose hook matches the plugin manifest, or update the plugin manifest if the hook should be supported',
      ]);
    }
    return fixtureHooks;
  }

  return availableHooks;
}

function isHookName(value: string): value is HookName {
  return value === 'normalize'
    || value === 'plan'
    || value === 'observe'
    || value === 'publish'
    || value === 'verify'
    || value === 'enrich'
    || value === 'render'
    || value === 'notify';
}

function buildSampleReleaseForHook(hook: HookName): ReturnType<typeof createBaseReleaseDocument> | null {
  return hook === 'normalize'
    ? null
    : createBaseReleaseDocument(buildSampleReleaseConfig(), {
      providerPlugin: sampleProviderPlugin,
      trigger: 'manual',
      ciSystem: 'generic-env',
      eventName: 'manual',
      receivedAt: sampleReceivedAt,
      owner: sampleRepositoryOwner,
      repo: sampleRepositoryName,
      sha: sampleReleaseSha,
      ref: sampleReleaseRef,
      refName: sampleReleaseRefName,
      refType: 'branch',
      stableBranch: true,
      dryRun: true,
      workflowUrl: sampleWorkflowUrl,
      completionStatus: 'completed',
    });
}

// Sample full release config for provider-plugin validation and for building a
// realistic sample normalized release document for later-phase hooks.
//
// Why keep this separate from the virtual LoadedConfig above?
// Because this object represents the *shape* plugin hooks see, not the outer
// config wrapper used only for plugin ref resolution.
function buildSampleReleaseConfig(): ReleaseConfig {
  return {
    api_version: 1,
    product_name: 'Plugin Validation Workspace',
    release_profile: sampleReleaseProfile,
    release_mode: 'framework-managed',
    provider_plugin: sampleProviderPlugin,
    profile_plugin: sampleProfilePlugin,
    tool_plugin: null,
    artifact_publishers: [],
    notifiers: [],
    metadata_enrichers: [],
    plugin_allowlist: [],
    allow_local_plugins: true,
    stable_branches: [sampleReleaseRefName],
    version_source: {
      type: sampleVersionSourceType,
    },
    tag_template: sampleTagTemplate,
    notes_source: {
      type: sampleNotesSourceType,
    },
    plugin_config: {},
  };
}

// Build the smallest useful runtime args bag for the hook under validation.
//
// Providers need enough CLI-like input to construct the initial release
// document. Later-phase hooks can usually validate against an already-built
// sample release document instead.
function buildRequestFixtureStep(requestJsonPath: string, hook: HookName): ValidatePluginStep {
  return {
    name: 'request-fixture-loaded',
    label: 'request fixture loaded',
    status: 'ok',
    details: [`request_source=${path.resolve(requestJsonPath)}`, `hook=${hook}`],
  };
}

// Why include request_source in human-readable output?
//
// Because plugin authors often try several fixtures in a row.
// Echoing the resolved fixture path back makes it easier to answer:
//
//   "which exact file shaped this validation run?"

// Multi-hook plugins are where authors most often wonder
// "which sample request should I use first?"
//
// We keep the suggestion small and deterministic:
// each declared hook points at the checked-in sample fixture with the same name.
//
// Why not auto-run every sample fixture here?
// Because `validate-plugin` is still a one-run command today.
// Suggestions are the lightest useful DX improvement without changing the
// command surface or making one invocation harder to reason about.
function buildFixtureSuggestionStep(hooks: HookName[]): ValidatePluginStep {
  return {
    name: 'request-fixture-suggestions',
    label: 'sample request fixtures available',
    status: 'ok',
    details: hooks.map((hook) => `${hook}=examples/plugins/requests/${hook}.request.json`),
  };
}

function buildSampleArgsForHook(hook: HookName): PluginRequest['inputs']['args'] {
  if (hook === 'normalize') {
    return {
      repo: `${sampleRepositoryOwner}/${sampleRepositoryName}`,
      sha: sampleReleaseSha,
      branch: sampleReleaseRefName,
    };
  }
  return {};
}

// Sample secrets let dry-run execution reach hooks that require secret names
// without needing real credentials during local authoring.
//
// Important rule:
// these are only placeholder values for contract validation. They prove that
// secret *wiring* works; they do not prove that a real downstream service would
// accept the credential.
function buildSampleSecrets(requiredSecrets: string[], optionalSecrets: string[]): StringMap {
  const secrets: StringMap = {};
  for (const secretName of [...requiredSecrets, ...optionalSecrets]) {
    secrets[secretName] = `${sampleSecretPrefix}${secretName.toLowerCase()}`;
  }
  return secrets;
}

// Reject mutually incompatible option combinations early, before any plugin
// loading or execution starts.
//
// Why reject --plugin-config-json + --request-json together?
// Because a request fixture already carries its own config field. Allowing both
// would create ambiguity about which config object takes precedence.
function assertValidatePluginOptions(options: ValidatePluginCommandOptions): void {
  if (options.plugin_config_json && ((options.request_json && options.request_json.length > 0) || options.request_json_dir)) {
    throw new ValidatePluginCommandError('cannot use --plugin-config-json together with request fixtures', [
      'next_step=put config inside the request fixture when using --request-json or --request-json-dir, or remove the request fixture override and validate plugin-local config separately',
    ]);
  }

  if (options.request_json && options.request_json.length > 0 && options.request_json_dir) {
    throw new ValidatePluginCommandError('cannot use --request-json together with --request-json-dir', [
      'next_step=pass explicit request fixture paths with --request-json, or pass one directory with --request-json-dir, but not both in the same run',
    ]);
  }
}

// `--hook` and `--request-json` are both ways to answer the same question:
// which hook are we validating?
//
// If the author provides both, they should agree. Otherwise the command would
// silently validate one hook while the fixture was shaped for another.
function assertCompatibleHookSelection(
  requestedHook: string | undefined,
  requestFixtures: ValidatePluginRequestFixture[],
  requestJsonPaths: string[],
): void {
  if (!requestedHook) {
    return;
  }

  if (requestFixtures.length > 1) {
    throw new ValidatePluginCommandError('cannot use --hook together with multiple request fixtures', [
      'next_step=omit --hook and let each fixture validate its own declared hook, or pass exactly one request fixture',
    ]);
  }

  const fixtureHook = requestFixtures[0]?.hook;
  if (!fixtureHook || requestedHook === fixtureHook) {
    return;
  }

  const details = [
    'next_step=use --hook that matches the fixture hook, or switch to a request fixture for the hook you want to validate',
  ];

  const requestJsonPath = requestJsonPaths[0];
  if (requestJsonPath) {
    details.unshift(`request_source=${path.resolve(requestJsonPath)}`);
  }

  throw new ValidatePluginCommandError(`requested hook ${requestedHook} does not match request fixture hook ${fixtureHook}`, details);
}

// Request fixtures let plugin authors validate against richer, more realistic
// hook inputs than the built-in defaults.
//
// A useful mental model is:
//
//   one fixture
//      ↓
//   one hook
//      ↓
//   one concrete request shape
//
// Visual model:
//
//   request fixture JSON
//          ↓
//   parsed + validated fixture
//          ↓
//   runPluginHook(...) using fixture values
//
// The fixture shape intentionally mirrors most of PluginRequest, but the
// framework still owns plugin metadata like plugin name/version.
// Parse and validate a request fixture JSON file.
//
// Visual model:
//
//   request fixture JSON on disk
//          ↓
//   readRawJson → parse top-level fields
//          ↓
//   validate each field (hook, dry_run, release, inputs, secrets, workspace)
//          ↓
//   structured ValidatePluginRequestFixture
//
// Each field is validated independently so the author gets a specific
// error message pointing at the exact field that is missing or malformed.
function resolveRequestJsonPaths(options: ValidatePluginCommandOptions, availableHooks: HookName[]): string[] {
  if (options.request_json && options.request_json.length > 0) {
    return options.request_json;
  }
  if (!options.request_json_dir) {
    return [];
  }

  // Validate declared-hook compatibility before directory matching.
  //
  // Why check here?
  // Because a command such as
  //
  //   validate-plugin ... --hook notify --request-json-dir fixtures/
  //
  // should fail as
  //
  //   "notify is not declared by this plugin"
  //
  // instead of the more confusing
  //
  //   "no request fixtures matched"
  //
  // when the real problem is the hook selection, not the directory contents.
  if (options.hook && (!isHookName(options.hook) || !availableHooks.includes(options.hook))) {
    throw new ValidatePluginCommandError(`requested hook ${options.hook} is not declared by the plugin`, [
      `declared_hooks=${availableHooks.join(', ')}`,
      'next_step=choose one of the declared hooks or omit --hook to validate all declared hooks',
    ]);
  }

  return readRequestFixturePathsFromDirectory(options.request_json_dir, availableHooks, options.hook);
}

// Directory mode is meant to remove typing friction for multi-hook plugins.
//
// Visual model:
//
//   --request-json-dir fixtures/
//            ↓
//   look for <hook>.request.json files
//            ↓
//   build one fixture-driven validation plan per matched hook
function readRequestFixturePathsFromDirectory(
  requestJsonDir: string,
  availableHooks: HookName[],
  requestedHook?: string,
): string[] {
  const resolvedDir = path.resolve(requestJsonDir);
  let directoryEntries: string[];
  try {
    directoryEntries = fs.readdirSync(resolvedDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidatePluginCommandError(`could not read request fixture directory ${resolvedDir}`, [
      `cause=${message}`,
      'next_step=check that --request-json-dir points at an existing directory containing <hook>.request.json files',
    ]);
  }

  const hooksToMatch = requestedHook
    ? [validateRequestedHookName(requestedHook)]
    : availableHooks;
  const matchedPaths = hooksToMatch
    .map((hook) => ({
      hook,
      fixturePath: path.join(resolvedDir, `${hook}.request.json`),
    }))
    .filter(({ fixturePath }) => directoryEntries.includes(path.basename(fixturePath)));

  if (matchedPaths.length === 0) {
    throw new ValidatePluginCommandError(`no request fixtures matched in directory ${resolvedDir}`, [
      ...hooksToMatch.map((hook) => `expected=${path.join(resolvedDir, `${hook}.request.json`)}`),
      'next_step=add one or more <hook>.request.json files to the directory, or use explicit --request-json paths instead',
    ]);
  }

  return matchedPaths.map(({ fixturePath }) => fixturePath);
}

function validateRequestedHookName(value: string): HookName {
  if (!isHookName(value)) {
    throw new ValidatePluginCommandError(`requested hook ${value} is not a valid hook name`, [
      'next_step=use one of normalize, plan, observe, publish, verify, enrich, render, notify',
    ]);
  }
  return value;
}

function readRequestFixtures(requestJsonPaths?: string[]): ValidatePluginRequestFixture[] {
  if (!requestJsonPaths || requestJsonPaths.length === 0) {
    return [];
  }

  // Visual model:
  //
  //   --request-json a.json b.json
  //          ↓
  //   parse each file independently
  //          ↓
  //   reject duplicate hooks
  //          ↓
  //   one fixture-driven run plan per hook
  const fixtures = requestJsonPaths.map((requestJsonPath) => readRequestFixture(requestJsonPath));
  const seenHooks = new Set<HookName>();
  for (const fixture of fixtures) {
    if (seenHooks.has(fixture.hook)) {
      throw new ValidatePluginCommandError(`request fixtures must not repeat hook ${fixture.hook}`, [
        'next_step=pass at most one request fixture per hook so each validation run has one concrete request shape',
      ]);
    }
    seenHooks.add(fixture.hook);
  }
  return fixtures;
}

function readRequestFixture(requestJsonPath: string): ValidatePluginRequestFixture {
  const parsed = readJsonObjectFile(requestJsonPath);
  const hook = readHookName(parsed.hook, requestJsonPath);
  const dryRun = readBoolean(parsed.dry_run, 'dry_run', requestJsonPath);
  const config = 'config' in parsed ? parsed.config : {};
  const release = readReleaseValue(parsed.release, requestJsonPath);
  const inputs = readRequestInputs(parsed.inputs, requestJsonPath);
  const secrets = readStringMap(parsed.secrets, 'secrets', requestJsonPath);
  const workspace = readWorkspace(parsed.workspace, requestJsonPath);

  return {
    hook,
    dry_run: dryRun,
    config,
    release,
    inputs,
    secrets,
    workspace,
  };
}

function readRequestInputs(value: unknown, requestJsonPath: string): PluginRequest['inputs'] {
  if (!isObject(value)) {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include inputs object`, [
      'next_step=provide inputs.env, inputs.args, and inputs.files fields in the request fixture JSON',
    ]);
  }

  return {
    env: readEnvMap(value.env, requestJsonPath),
    args: readArgsMap(value.args, requestJsonPath),
    files: readStringMap(value.files, 'inputs.files', requestJsonPath),
  };
}

function readWorkspace(value: unknown, requestJsonPath: string): PluginRequest['workspace'] {
  if (!isObject(value) || typeof value.root !== 'string' || value.root.length === 0) {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include workspace.root`, [
      'next_step=provide a non-empty workspace.root string in the request fixture JSON',
    ]);
  }
  return {
    root: value.root,
  };
}

// The request fixture release field depends on the hook:
//
//   release: null       → normalize hooks (release doesn't exist yet)
//   release: <object>   → later-phase hooks (release already built)
//   release: missing    → error (author must choose one)
function readReleaseValue(value: unknown, requestJsonPath: string): NormalizedRelease | null {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include release`, [
      'next_step=use release=null for normalize hooks, or provide a normalized release object for later-phase hooks',
    ]);
  }
  return validateNormalizedRelease(value);
}

function readHookName(value: unknown, requestJsonPath: string): HookName {
  if (typeof value !== 'string' || !isHookName(value)) {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include a valid hook`, [
      'next_step=use one of normalize, plan, observe, publish, verify, enrich, render, notify',
    ]);
  }
  return value;
}

function readBoolean(value: unknown, fieldName: string, requestJsonPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include boolean ${fieldName}`, [
      `next_step=provide ${fieldName}: true or false in the request fixture JSON`,
    ]);
  }
  return value;
}

function readEnvMap(value: unknown, requestJsonPath: string): EnvMap {
  if (!isObject(value)) {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include inputs.env object`, [
      'next_step=provide inputs.env as an object map in the request fixture JSON',
    ]);
  }

  const env: EnvMap = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') {
      throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} inputs.env values must be strings`, [
        `field=inputs.env.${key}`,
      ]);
    }
    env[key] = entryValue;
  }
  return env;
}

function readArgsMap(value: unknown, requestJsonPath: string): RuntimeArgs {
  if (!isObject(value)) {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include inputs.args object`, [
      'next_step=provide inputs.args as an object map in the request fixture JSON',
    ]);
  }

  const args: RuntimeArgs = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (!isJsonValue(entryValue)) {
      throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} inputs.args values must be JSON-safe`, [
        `field=inputs.args.${key}`,
      ]);
    }
    args[key] = entryValue;
  }
  return args;
}

function readStringMap(value: unknown, fieldName: string, requestJsonPath: string): StringMap {
  if (!isObject(value)) {
    throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} must include ${fieldName} object`, [
      `next_step=provide ${fieldName} as an object with string values in the request fixture JSON`,
    ]);
  }

  const map: StringMap = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') {
      throw new ValidatePluginCommandError(`request fixture ${requestJsonPath} ${fieldName} values must be strings`, [
        `field=${fieldName}.${key}`,
      ]);
    }
    map[key] = entryValue;
  }
  return map;
}

function isObject(value: unknown): value is UnknownMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

// Wrap plugin-config validation errors for consistent human/JSON output.
//
// When the error came from PluginConfigValidationError, we forward the
// structured details directly. For unexpected errors, we build a minimal
// context block with a next_step hint.
function buildValidatePluginConfigError(pluginRef: string, configSource: string, error: unknown): ValidatePluginCommandError {
  if (error instanceof PluginConfigValidationError) {
    return new ValidatePluginCommandError(`plugin ${pluginRef} failed plugin-config validation`, [
      `config_source=${configSource}`,
      ...error.details,
    ]);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ValidatePluginCommandError(`plugin ${pluginRef} failed plugin-config validation`, [
    `config_source=${configSource}`,
    `cause=${message}`,
    'next_step=check the plugin config JSON object and the manifest config_schema path',
  ]);
}

// Wrap hook execution errors for consistent human/JSON output.
//
// These errors surface subprocess failures, response contract violations, and
// timeout/size-limit violations with enough context for the author to debug.
function buildValidatePluginExecutionError(
  pluginRef: string,
  hook: HookName,
  error: unknown,
  requestSource?: string,
): ValidatePluginCommandError {
  const message = error instanceof Error ? error.message : String(error);
  const details = [
    `hook=${hook}`,
    `cause=${message}`,
    'next_step=if stdout contains debug text, move it to stderr; if config is wrong, rerun with a request fixture or --plugin-config-json; if the hook is wrong, rerun with --hook <declared-hook>',
  ];
  if (requestSource) {
    details.splice(1, 0, `request_source=${requestSource}`);
  }
  return new ValidatePluginCommandError(`plugin ${pluginRef} failed during dry-run hook execution`, details);
}
