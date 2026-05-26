import { validateNormalizedRelease } from '../release-json/invariants.js';

/**
 * This file is the plugin execution boundary.
 *
 * We keep it small on purpose.
 * A future reader should be able to audit plugin execution without paging
 * through unrelated orchestration logic.
 *
 * The job here is only:
 * - build the request envelope
 * - execute the requested hook (built-in or subprocess)
 * - fail clearly if the plugin misbehaves
 * - merge the returned patch back into the shared release document
 */
import { applyMergePatch } from '../release-json/merge-patch.js';
import type { NormalizedRelease } from '../release-json/schema.js';
import type { EnvMap, RuntimeArgs, StringMap } from '../types/runtime.js';
import type { PluginHandler, PluginRequest, PluginResponse, HookName } from '../plugins/request-response.js';
import type { PluginManifest } from '../plugins/manifest.js';
import { validatePluginResponse } from '../plugins/response-validation.js';
import { runExternalPluginHook } from '../plugins/subprocess-runner.js';

// Everything a plugin hook call needs in one place.
//
// Visual model:
//
//   manifest   -> declared contract
//   handler    -> built-in implementation, if any
//   pluginRoot -> external plugin directory, if any
//   release    -> current shared release document
//   args/env   -> runtime inputs
//   secrets    -> explicit secret bag
//
// The context is intentionally explicit so a future reader can see exactly what
// data crosses the plugin boundary during one hook execution.
export interface HookExecutionContext {
  manifest: PluginManifest;
  handler?: PluginHandler;
  hook: HookName;
  dryRun: boolean;
  pluginConfig: unknown;
  release: NormalizedRelease | null;
  args: RuntimeArgs;
  env: EnvMap;
  files?: StringMap;
  workspaceRoot: string;
  secrets?: StringMap;
  pluginRoot?: string;
  hookTimeoutMs?: number;
}

export class PluginExecutionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Execute one plugin hook.
 *
 * Why we do merge-patch here:
 * plugins should modify only the fields they own, not replace the whole
 * release document. That keeps plugins loosely coupled.
 */
export async function runPluginHook(context: HookExecutionContext): Promise<{
  response: PluginResponse;
  release: NormalizedRelease | null;
}> {
  // First check the manifest contract, then the actual handler implementation.
  //
  // Why this order?
  // Because "hook is not declared" and "hook is declared but missing at
  // runtime" are different classes of mistakes:
  //
  // - undeclared hook  -> manifest/runtime contract bug
  // - missing handler  -> implementation wiring bug
  //
  // Keeping those failures separate makes plugin debugging much less magical.
  if (!context.manifest.hooks.includes(context.hook)) {
    throw new PluginExecutionError(`plugin ${context.manifest.name} does not declare required hook ${context.hook}`);
  }

  // Build the request envelope that every plugin sees.
  // This keeps built-ins and external subprocess plugins on the same logical
  // contract even though their execution models differ.
  const request: PluginRequest = {
    plugin_api_version: 1,
    hook: context.hook,
    dry_run: context.dryRun,
    plugin: {
      name: context.manifest.name,
      version: context.manifest.plugin_version,
    },
    config: context.pluginConfig,
    release: context.release,
    inputs: {
      env: selectPluginInputEnv(context),
      args: context.args,
      files: context.files ?? {},
    },
    secrets: context.secrets ?? {},
    workspace: {
      root: context.workspaceRoot,
    },
  };

  // Built-ins run through their in-process handler.
  // External plugins run through the subprocess boundary.
  //
  // Both paths return one logical thing: "raw plugin response to validate".
  const hookHandler = context.handler?.[context.hook];
  const rawResponse = hookHandler
    ? await hookHandler(request)
    : context.pluginRoot
      ? await runExternalPluginHook(context.manifest, context.pluginRoot, request, context.hookTimeoutMs)
      : undefined;

  if (rawResponse === undefined) {
    const message = context.manifest.entrypoint.kind === 'builtin'
      ? `plugin ${context.manifest.name} does not implement required hook ${context.hook}`
      : `plugin ${context.manifest.name} is missing an executable plugin root for external execution`;
    throw new PluginExecutionError(message);
  }

  // Validate the response before merge-patching anything.
  //
  // This is the point where plugin-local behavior becomes shared framework
  // state, so the contract needs to be fully checked here.
  const response = validatePluginResponse(rawResponse);

  // A plugin returns a merge patch, not a whole new world.
  // That rule keeps ownership boundaries simple: plugins patch the fields they
  // own, then core preserves everything else.
  if (response.status === 'error') {
    throw new PluginExecutionError(response.error_message ?? `plugin ${context.manifest.name} failed during ${context.hook}`);
  }

  const nextRelease = context.release
    ? applyMergePatch(context.release, response.release_patch)
    : shouldCreateReleaseDocument(response.release_patch)
      ? validateInitialReleaseDocument(response.release_patch)
      : null;

  return {
    response,
    release: nextRelease,
  };
}

/**
 * Only normalize hooks are allowed to create the first release document.
 * Other hooks always patch an existing document.
 */
function shouldCreateReleaseDocument(patch: unknown): boolean {
  return typeof patch === 'object' && patch !== null && Object.keys(patch).length > 0;
}

/**
 * The initial document must already satisfy the normalized-release contract.
 * That gives every later phase one stable starting point.
 */
function validateInitialReleaseDocument(patch: unknown): NormalizedRelease {
  return validateNormalizedRelease(patch);
}

// External plugins get an empty `inputs.env` by default.
//
// Why be this strict?
// Because `request.secrets` is the explicit secret boundary. Passing the full
// runtime environment through `inputs.env` would make it too easy for external
// plugins to depend on ambient CI state or accidentally observe unrelated
// secrets. Built-ins stay on the richer in-process contract for now.
function selectPluginInputEnv(context: HookExecutionContext): EnvMap {
  return context.manifest.entrypoint.kind === 'builtin'
    ? context.env
    : {};
}
