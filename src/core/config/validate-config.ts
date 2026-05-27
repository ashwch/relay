import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import parseSemver from 'semver/functions/parse.js';

import { readJsonObjectFile } from '../io/files.js';
import {
  dynamicSemverVersionSourceTypes,
  fileVersionSourceFormats,
  versionSourceUsesCounter,
  versionSourceTypes,
} from '../version-source.js';
import type { PluginSelection, PluginSelectionObject, ReleaseConfig } from './types.js';

const schemaPath = path.resolve(import.meta.dirname, '../../../schemas/release-config.schema.json');
const schema = readJsonObjectFile(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile<ReleaseConfig>(schema);

const builtinSlackWebhookPlugin = 'builtin:slack-webhook';
const builtinGitHubReleaseAssetsPlugin = 'builtin:github-release-assets';
const builtinNpmRegistryVerifyPlugin = 'builtin:npm-registry-verify';

// Plugin refs stay prefix-based on purpose.
//
// Visual model:
//
//   builtin:... -> checked into Relay itself
//   npm:...     -> resolved from installed packages
//   git:...     -> cloned/fetched into Relay's git plugin cache
//   path:...    -> resolved from the local config directory
//
// Why validate this early?
// Because a config typo such as `github.com/acme/plugin` is much easier to
// explain at config-load time than later during plugin resolution.
const allowedPluginRefPrefixes = ['builtin:', 'npm:', 'git:', 'path:'] as const;
const allowedPluginRefPrefixList = allowedPluginRefPrefixes.join(', ');
const supportedSemverIncrements = new Set(['major', 'minor', 'patch']);

// This file performs two different kinds of checks:
//
// 1. JSON schema validation
//    -> does the shape look valid at all?
//
// 2. semantic validation
//    -> does the config make sense for how Relay actually behaves?
//
// The newer version sources especially need semantic checks because some bad
// configs are structurally valid JSON/YAML but still guaranteed to fail later
// at runtime unless we explain the mistake here.

export class ConfigValidationError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

export function validateConfig(candidate: unknown): ReleaseConfig {
  if (!validate(candidate)) {
    const genericDetails = (validate.errors ?? []).map((error: { instancePath?: string; message?: string }) => {
      const pointer = error.instancePath || '/';
      return `${pointer} ${error.message ?? 'validation error'}`;
    });
    const friendlyVersionSourceDetails = readFriendlyVersionSourceSchemaErrors(candidate);
    const details = friendlyVersionSourceDetails
      ? [
        ...friendlyVersionSourceDetails,
        ...genericDetails.filter((detail) => !detail.startsWith('/version_source')),
      ]
      : genericDetails;
    throw new ConfigValidationError('invalid relay config', details);
  }

  const config = candidate;
  const semanticErrors = [
    ...validateVersioningConfig(config),
    ...validatePluginRefs(config),
    ...validateReleaseModeConfig(config),
    ...validateSlackConfig(config),
    ...validateArtifactConfig(config),
  ];
  if (semanticErrors.length > 0) {
    throw new ConfigValidationError('invalid relay config', semanticErrors);
  }

  return config;
}

// Keep versioning failures close to config load time instead of surprising the
// user later during a release run.
//
// Visual rule:
//
//   easy to explain in config review
//         ↓
//   reject here
//
//   only discoverable after git/files/env inspection
//         ↓
//   runtime resolver handles it
//
// AJV's generic `oneOf` output becomes noisy for version_source because many
// source shapes share the same object slot. For file-backed versioning we
// prefer one human explanation over dozens of low-signal schema messages.
function readFriendlyVersionSourceSchemaErrors(candidate: unknown): string[] | undefined {
  if (!isRecord(candidate) || !isRecord(candidate.version_source)) {
    return undefined;
  }

  const source = candidate.version_source;

  // Relay intentionally collapsed package-json into the generic file source.
  // A custom message makes that migration obvious to future readers.
  if (source.type === 'package-json') {
    return [
      '/version_source/type package-json has been removed; use version_source.type=file with format=json, path=package.json, and key_path=[version]',
    ];
  }

  if (source.type !== versionSourceTypes.file) {
    return undefined;
  }

  // Keep these checks duplicated very lightly from the schema on purpose.
  // The schema answers "is this shape allowed?".
  // These messages answer "what should I change right now?".
  const errors: string[] = [];
  if (source.format !== fileVersionSourceFormats.json
    && source.format !== fileVersionSourceFormats.yaml
    && source.format !== fileVersionSourceFormats.toml) {
    errors.push('/version_source/format file version sources require version_source.format to be one of: json, yaml, toml');
  }
  if (!isNonEmptyString(source.path)) {
    errors.push('/version_source/path file version sources require version_source.path to be a non-empty string');
  }
  if (!Array.isArray(source.key_path) || source.key_path.length === 0 || !source.key_path.every(isNonEmptyString)) {
    errors.push('/version_source/key_path file version sources require version_source.key_path to be a non-empty array of non-empty strings');
  }

  return errors.length > 0 ? errors : undefined;
}

function validateVersioningConfig(config: ReleaseConfig): string[] {
  const errors: string[] = [];
  const source = config.version_source;

  const counterSource = typeof source.counter_source === 'string'
    ? source.counter_source
    : 'github-tag';

  const needsVisibleCounter = versionSourceUsesCounter(source);
  if (needsVisibleCounter && !containsAnyPlaceholder(config.tag_template, ['{version}', '{counter}'])) {
    errors.push('/tag_template counter-based versioning requires tag_template to include {version} or {counter}');
  }

  if (source.type === versionSourceTypes.template && typeof source.template === 'string' && source.template.includes('{version}')) {
    errors.push('/version_source/template custom version templates may not reference {version}; use concrete fields such as {date}, {counter}, {short_sha}, {sha}, {branch}, or {time}');
  }

  if (source.type === versionSourceTypes.template && typeof source.template === 'string') {
    errors.push(...validateTemplatePlaceholders('/version_source/template', source.template, ['date', 'counter', 'short_sha', 'sha', 'branch', 'time']));
  }

  errors.push(...validateTemplatePlaceholders('/tag_template', config.tag_template, ['version', 'date', 'counter', 'short_sha', 'sha', 'branch', 'time']));

  if (counterSource === 'explicit' && !isPositiveInteger(source.counter)) {
    errors.push('/version_source/counter explicit counter sources require version_source.counter to be a positive integer');
  }

  if (source.type === versionSourceTypes.env && !isNonEmptyString(source.key)) {
    errors.push('/version_source/key env version sources require version_source.key');
  }

  // `git-tag` patterns are special because a regex can be syntactically valid
  // and still be useless for extraction. We reject both:
  // - invalid regex syntax
  // - valid regex with no way to capture the version
  if (source.type === versionSourceTypes.gitTag && isNonEmptyString(source.pattern)) {
    const patternErrors = validateRegexPattern('/version_source/pattern', source.pattern);
    errors.push(...patternErrors);
    if (patternErrors.length === 0 && !containsVersionCaptureGroup(source.pattern)) {
      errors.push('/version_source/pattern git-tag extraction patterns must include a named (?<version>...) group or a positional capture group');
    }
  }

  // Changesets works only when Relay knows which package to inspect.
  // Requiring that here avoids much more confusing downstream errors once the
  // resolver starts walking .changeset files.
  if (source.type === versionSourceTypes.changesets) {
    if (!isNonEmptyString(source.package) && !isNonEmptyString(config.package?.name)) {
      errors.push('/version_source/package changesets version sources require version_source.package or package.name');
    }
    if (source.directory !== undefined && !isNonEmptyString(source.directory)) {
      errors.push('/version_source/directory changesets version sources require version_source.directory to be a non-empty string when provided');
    }
  }

  // The semver-generating sources share a small common contract:
  // optional initial_version, optional default_increment, optional tag_prefix.
  //
  // One extra rule matters a lot here:
  // the generated tag must expose {version}. Otherwise Relay can compute a
  // semver value, but future runs cannot learn it back from previously created
  // tags in a reliable way.
  if (dynamicSemverVersionSourceTypes.has(source.type)) {
    errors.push(...validateOptionalSemver('/version_source/initial_version', source.initial_version));
    errors.push(...validateOptionalIncrement('/version_source/default_increment', source.default_increment));
    if (source.tag_prefix !== undefined && typeof source.tag_prefix !== 'string') {
      errors.push('/version_source/tag_prefix must be a string when provided');
    }
    if (!config.tag_template.includes('{version}')) {
      errors.push('/tag_template dynamic semver versioning requires tag_template to include {version} so previously created tags remain discoverable');
    }
  }

  return errors;
}

function validatePluginRefs(config: ReleaseConfig): string[] {
  const pluginRefs = [
    { path: '/provider_plugin', value: config.provider_plugin },
    { path: '/profile_plugin', value: config.profile_plugin },
    ...(config.tool_plugin ? [{ path: '/tool_plugin', value: config.tool_plugin }] : []),
    ...selectionRefs('/artifact_publishers', config.artifact_publishers ?? []),
    ...selectionRefs('/notifiers', config.notifiers ?? []),
    ...selectionRefs('/metadata_enrichers', config.metadata_enrichers ?? []),
    ...(config.plugin_allowlist ?? []).map((value, index) => ({
      path: `/plugin_allowlist/${index}`,
      value,
    })),
  ];

  return pluginRefs.flatMap((pluginRef) => isExplicitPluginRef(pluginRef.value)
    ? []
    : [`${pluginRef.path} plugin refs must start with ${allowedPluginRefPrefixList}`]);
}

function validateReleaseModeConfig(config: ReleaseConfig): string[] {
  if ((config.release_mode === 'tool-observe' || config.release_mode === 'tool-wrap') && !config.tool_plugin) {
    return [`/tool_plugin release_mode=${config.release_mode} requires tool_plugin`];
  }

  if (config.release_mode === 'framework-managed' && config.tool_plugin) {
    return ['/tool_plugin framework-managed releases should not configure tool_plugin; core owns the release record'];
  }

  return [];
}

function validateSlackConfig(config: ReleaseConfig): string[] {
  const errors: string[] = [];
  const notifierSelections = (config.notifiers ?? []).map(normalizePluginSelection);
  const hasSlackNotifier = notifierSelections.some((selection) => selection.plugin === builtinSlackWebhookPlugin);

  if (config.slack?.enabled === true && !hasSlackNotifier) {
    errors.push('/slack enabled Slack config requires notifiers to include builtin:slack-webhook');
  }

  for (const [index, selection] of notifierSelections.entries()) {
    if (selection.plugin !== builtinSlackWebhookPlugin) {
      continue;
    }

    const webhookSecret = selection.options?.webhook_secret;
    if (webhookSecret !== undefined && !isNonEmptyString(webhookSecret)) {
      errors.push(`/notifiers/${index}/options/webhook_secret must be a non-empty string when provided`);
    }
  }

  return errors;
}

function validateArtifactConfig(config: ReleaseConfig): string[] {
  const errors: string[] = [];
  const artifactSelections = (config.artifact_publishers ?? []).map(normalizePluginSelection);
  for (const [index, selection] of artifactSelections.entries()) {
    const options = selection.options ?? {};
    if (selection.plugin === builtinGitHubReleaseAssetsPlugin) {
      errors.push(...validateOptionalStringArray(`/artifact_publishers/${index}/options/required_assets`, options.required_assets));
      errors.push(...validateOptionalStringArray('/assets/required_assets', config.assets?.required_assets));
      errors.push(...validateOptionalStringArray('/assets/required', config.assets?.required));
      errors.push(...validateOptionalStringArray('/assets/asset_names', config.assets?.asset_names));
    }

    if (selection.plugin === builtinNpmRegistryVerifyPlugin) {
      const optionRegistryUrl = readOptionalString(options.registry_url);
      const packageRegistryUrl = readOptionalString(config.package?.registry_url);
      if (optionRegistryUrl && !isHttpsUrl(optionRegistryUrl)) {
        errors.push(`/artifact_publishers/${index}/options/registry_url must be a valid https:// URL when provided`);
      }
      if (packageRegistryUrl && !isHttpsUrl(packageRegistryUrl)) {
        errors.push('/package/registry_url must be a valid https:// URL when provided');
      }
    }
  }

  return errors;
}

function selectionRefs(pathPrefix: string, selections: PluginSelection[]): Array<{ path: string; value: string }> {
  return selections.map((selection, index) => {
    const normalized = normalizePluginSelection(selection);
    return {
      path: `${pathPrefix}/${index}/plugin`,
      value: normalized.plugin,
    };
  });
}

function normalizePluginSelection(selection: PluginSelection): PluginSelectionObject {
  if (typeof selection === 'string') {
    return { plugin: selection };
  }
  return selection;
}

function validateTemplatePlaceholders(pathPrefix: string, template: string, allowedPlaceholders: string[]): string[] {
  const allowed = new Set(allowedPlaceholders);
  const errors: string[] = [];
  const placeholderPattern = /\{([^{}]+)\}/g;
  let match = placeholderPattern.exec(template);
  while (match) {
    const placeholderName = match[1];
    if (!/^[a-z_]+$/.test(placeholderName) || !allowed.has(placeholderName)) {
      errors.push(`${pathPrefix} unsupported placeholder {${placeholderName}}`);
    }
    match = placeholderPattern.exec(template);
  }

  const placeholderMatches = template.match(/\{[^{}]+\}/g) ?? [];
  const consumedBraces = placeholderMatches.length * 2;
  const allBraces = (template.match(/[{}]/g) ?? []).length;
  if (consumedBraces !== allBraces) {
    errors.push(`${pathPrefix} contains malformed placeholder braces`);
  }

  return errors;
}

function validateOptionalStringArray(pathPrefix: string, value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    return [`${pathPrefix} must be an array of non-empty strings when provided`];
  }
  return [];
}

function validateOptionalSemver(pathPrefix: string, value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  return isValidSemver(value) ? [] : [`${pathPrefix} must be a valid semver string when provided`];
}

function validateOptionalIncrement(pathPrefix: string, value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  return typeof value === 'string' && supportedSemverIncrements.has(value)
    ? []
    : [`${pathPrefix} must be one of: major, minor, patch`];
}

function validateRegexPattern(pathPrefix: string, value: string): string[] {
  try {
    new RegExp(value);
    return [];
  } catch {
    return [`${pathPrefix} must be a valid regular expression`];
  }
}

// Detect whether a git-tag regex can actually extract a version.
//
// Accepted shapes:
// - named capture:      ^v(?<version>.+)$
// - positional capture: ^v(.+)$
//
// Rejected shape:
// - no capture at all:  ^v.+$
function containsVersionCaptureGroup(pattern: string): boolean {
  if (pattern.includes('(?<version>')) {
    return true;
  }

  return /(^|[^\\])\((?!\?[:=!<])/.test(pattern);
}

function containsAnyPlaceholder(template: string, placeholders: string[]): boolean {
  return placeholders.some((placeholder) => template.includes(placeholder));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isExplicitPluginRef(pluginRef: string): boolean {
  return allowedPluginRefPrefixes.some((prefix) => pluginRef.startsWith(prefix));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidSemver(value: unknown): value is string {
  return typeof value === 'string' && parseSemver(value) !== null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isHttpsUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  return new URL(value).protocol === 'https:';
}
