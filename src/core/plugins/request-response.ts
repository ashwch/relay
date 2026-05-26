import type { NormalizedRelease } from '../release-json/schema.js';
import type { EnvMap, RuntimeArgs, StringMap, UnknownMap } from '../types/runtime.js';
import type { JsonObject } from '../types/json.js';

/**
 * Plugin request/response types.
 *
 * These types describe the logical contract between core and every plugin.
 *
 * Even when built-ins run in-process today, we still model the boundary this
 * way so the contract stays explicit and future external plugin execution can
 * reuse the same mental model.
 */

export type PluginType =
  | 'provider'
  | 'release_tool'
  | 'profile'
  | 'artifact_publisher'
  | 'notifier'
  | 'metadata_enricher';

export type HookName = 'normalize' | 'plan' | 'observe' | 'publish' | 'verify' | 'enrich' | 'render' | 'notify';

/**
 * Everything core gives a plugin for one hook call.
 *
 * Visual model:
 *
 *   config    -> this plugin's resolved options
 *   release   -> current shared release document
 *   inputs    -> runtime inputs such as args/files/env
 *   secrets   -> explicit secret channel
 *   workspace -> working directory context
 *
 * Why keep this envelope explicit?
 * Because we want built-ins and external subprocess plugins to reason about the
 * same contract even if they run in different ways.
 */
export interface PluginRequest {
  plugin_api_version: 1;
  hook: HookName;
  dry_run: boolean;
  plugin: {
    name: string;
    version: string;
  };
  config: unknown;
  release: NormalizedRelease | null;
  inputs: {
    env: EnvMap;
    args: RuntimeArgs;
    files: StringMap;
  };
  secrets: StringMap;
  workspace: {
    root: string;
  };
}

/**
 * Everything a plugin is allowed to return to core.
 *
 * Visual model:
 *
 *   status        -> did the hook succeed, noop, or fail?
 *   release_patch -> what should change in shared release state?
 *   outputs       -> extra structured hook-local output
 *   logs          -> small structured log records
 *
 * The most important rule is that `release_patch` is a patch, not a full
 * replacement document.
 */
export interface PluginResponse {
  status: 'ok' | 'noop' | 'error';
  release_patch: unknown;
  outputs: UnknownMap;
  logs: Array<{
    level: 'info' | 'warn' | 'error';
    message: string;
  }>;
  error_code?: string;
  error_message?: string;
}

/**
 * Plugin response after core has validated the boundary contract.
 *
 * Why keep a second type?
 * Because there are two different moments in the lifecycle:
 *
 *   PluginResponse          -> what plugin code is allowed to attempt
 *   ValidatedPluginResponse -> what core is willing to trust
 *
 * That distinction becomes even more useful once external subprocess plugins
 * start returning JSON over stdout.
 */
export interface ValidatedPluginResponse extends PluginResponse {
  release_patch: JsonObject;
  outputs: JsonObject;
}

/**
 * Hook surface available to plugin implementations.
 */
export interface PluginHandler {
  normalize?(request: PluginRequest): Promise<PluginResponse>;
  plan?(request: PluginRequest): Promise<PluginResponse>;
  observe?(request: PluginRequest): Promise<PluginResponse>;
  publish?(request: PluginRequest): Promise<PluginResponse>;
  verify?(request: PluginRequest): Promise<PluginResponse>;
  enrich?(request: PluginRequest): Promise<PluginResponse>;
  render?(request: PluginRequest): Promise<PluginResponse>;
  notify?(request: PluginRequest): Promise<PluginResponse>;
}

/**
 * Small helper for the common "successful plugin response" shape.
 *
 * Why this helper exists:
 * many plugins just want to say
 *
 *   "status=ok, here is my patch, here are my outputs"
 *
 * without rewriting the envelope each time.
 */
export function okResponse(release_patch: unknown, outputs: UnknownMap = {}, message?: string): PluginResponse {
  return {
    status: 'ok',
    release_patch,
    outputs,
    logs: message ? [{ level: 'info', message }] : [],
  };
}
