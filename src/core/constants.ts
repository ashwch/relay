/**
 * Shared framework constants.
 *
 * Why this file exists:
 * the framework has several small runtime surfaces, and each surface needs to
 * agree on a handful of stable identifiers.
 *
 * Visual model:
 *
 *   constants.ts
 *      ↓
 *   CLI help text
 *   action defaults
 *   workflow defaults
 *   manifest/schema identifiers
 *
 * Without one shared home, these strings tend to drift over time.
 */
export const defaultConfigPath = '.github/relay.yml' as const;
export const pluginManifestApiVersion = 'relay.plugin/v1' as const;
export const releaseSchemaVersion = 'relay.release/v1' as const;
export const maxPluginResponseBytes = 256 * 1024;
export const maxPluginStderrBytes = 32 * 1024;
export const defaultPluginHookTimeoutMs = 30_000;
