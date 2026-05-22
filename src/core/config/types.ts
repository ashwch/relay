import type { JsonObject, JsonValue } from '../types/json.js';

export type ReleaseMode = 'framework-managed' | 'tool-observe' | 'tool-wrap';

export interface PluginSelectionObject {
  plugin: string;
  options?: JsonObject;
}

export type PluginSelection = string | PluginSelectionObject;

export interface VersionSource {
  type: string;
  [key: string]: JsonValue | undefined;
}

export interface NotesSource {
  type: string;
  [key: string]: JsonValue | undefined;
}

export interface ReleaseConfig {
  api_version: 1;
  product_name: string;
  release_profile: string;
  release_mode: ReleaseMode;
  provider_plugin: string;
  profile_plugin: string;
  tool_plugin?: string | null;
  artifact_publishers?: PluginSelection[];
  notifiers?: PluginSelection[];
  metadata_enrichers?: PluginSelection[];
  plugin_allowlist?: string[];
  allow_local_plugins?: boolean;
  stable_branches: string[];
  version_source: VersionSource;
  tag_template: string;
  notes_source: NotesSource;
  assets?: JsonObject;
  slack?: SlackConfig;
  package?: JsonObject;
  plugin_config?: JsonObject;
}

export interface SlackConfig {
  enabled?: boolean;
  webhook_secret?: string;
  [key: string]: JsonValue | undefined;
}

export interface LoadedConfig {
  path: string;
  dir: string;
  config: ReleaseConfig;
}
