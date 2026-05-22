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
 * - call the requested hook
 * - fail clearly if the plugin misbehaves
 * - merge the returned patch back into the shared release document
 */
import { applyMergePatch } from '../release-json/merge-patch.js';
import type { NormalizedRelease } from '../release-json/schema.js';
import type { EnvMap, RuntimeArgs, StringMap } from '../types/runtime.js';
import type { PluginHandler, PluginRequest, PluginResponse, HookName } from '../plugins/request-response.js';
import type { PluginManifest } from '../plugins/manifest.js';

// Everything a plugin hook call needs in one place.
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
  const hookHandler = context.handler?.[context.hook];
  if (!hookHandler) {
    const message = context.manifest.entrypoint.kind === 'builtin'
      ? `plugin ${context.manifest.name} does not implement required hook ${context.hook}`
      : `plugin ${context.manifest.name} cannot be executed yet because external plugin runtime loading is not implemented`;
    throw new PluginExecutionError(message);
  }

  // Build the request envelope that every plugin sees.
  // This keeps built-ins and future external plugins on the same logical
  // contract even if their execution models differ.
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
      env: context.env,
      args: context.args,
      files: context.files ?? {},
    },
    secrets: context.secrets ?? {},
    workspace: {
      root: context.workspaceRoot,
    },
  };

  const response = await hookHandler(request);

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
