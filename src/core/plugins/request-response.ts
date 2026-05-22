import type { NormalizedRelease } from '../release-json/schema.js';
import type { EnvMap, RuntimeArgs, StringMap, UnknownMap } from '../types/runtime.js';

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
 */
export function okResponse(release_patch: unknown, outputs: UnknownMap = {}, message?: string): PluginResponse {
  return {
    status: 'ok',
    release_patch,
    outputs,
    logs: message ? [{ level: 'info', message }] : [],
  };
}
