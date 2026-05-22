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
export const defaultConfigPath = '.github/release-framework.yml' as const;
export const pluginManifestApiVersion = 'release-framework.plugin/v1' as const;
export const releaseSchemaVersion = 'release-framework.release/v1' as const;
