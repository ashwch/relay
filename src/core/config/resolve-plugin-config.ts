import type { JsonObject, JsonValue } from '../types/json.js';
import type { LoadedConfig, PluginSelection, PluginSelectionObject } from './types.js';

export function normalizePluginSelection(selection: PluginSelection): PluginSelectionObject {
  if (typeof selection === 'string') {
    return { plugin: selection };
  }
  return selection;
}

export function resolvePluginConfig(loaded: LoadedConfig, pluginRef: string): JsonObject {
  const pluginConfig = loaded.config.plugin_config ?? {};
  const direct = pluginConfig[pluginRef];
  return isObject(direct) ? direct : {};
}

export function resolveSelectionPluginConfig(loaded: LoadedConfig, selection: PluginSelectionObject): JsonObject {
  return {
    ...resolvePluginConfig(loaded, selection.plugin),
    ...(selection.options ?? {}),
  };
}

export function resolveArtifactPluginConfig(loaded: LoadedConfig, selection: PluginSelectionObject): JsonObject {
  return {
    ...resolveArtifactBaseConfig(loaded, selection.plugin),
    ...resolvePluginConfig(loaded, selection.plugin),
    ...(selection.options ?? {}),
  };
}

export function resolveNotifierPluginConfig(loaded: LoadedConfig, selection: PluginSelectionObject): JsonObject {
  return {
    ...resolveNotifierBaseConfig(loaded, selection.plugin),
    ...resolvePluginConfig(loaded, selection.plugin),
    ...(selection.options ?? {}),
  };
}

export function resolveNotifierSelections(loaded: LoadedConfig): PluginSelectionObject[] {
  return (loaded.config.notifiers ?? []).map(normalizePluginSelection);
}

export function resolveArtifactPublishers(loaded: LoadedConfig): PluginSelectionObject[] {
  return (loaded.config.artifact_publishers ?? []).map(normalizePluginSelection);
}

export function resolveMetadataEnrichers(loaded: LoadedConfig): PluginSelectionObject[] {
  return (loaded.config.metadata_enrichers ?? []).map(normalizePluginSelection);
}

function resolveNotifierBaseConfig(loaded: LoadedConfig, pluginRef: string): JsonObject {
  if (pluginRef === 'builtin:slack-webhook' && loaded.config.slack) {
    return compactJsonObject(loaded.config.slack);
  }
  return {};
}

function resolveArtifactBaseConfig(loaded: LoadedConfig, pluginRef: string): JsonObject {
  if (pluginRef === 'builtin:github-release-assets' && loaded.config.assets) {
    return loaded.config.assets;
  }
  if (pluginRef === 'builtin:npm-registry-verify' && loaded.config.package) {
    return loaded.config.package;
  }
  return {};
}

function compactJsonObject(value: Record<string, JsonValue | undefined>): JsonObject {
  const compacted: JsonObject = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue !== undefined) {
      compacted[key] = entryValue;
    }
  }
  return compacted;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
