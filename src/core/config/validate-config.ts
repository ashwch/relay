import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { readJsonObjectFile } from '../io/files.js';
import type { PluginSelection, PluginSelectionObject, ReleaseConfig } from './types.js';

const schemaPath = path.resolve(import.meta.dirname, '../../../schemas/release-config.schema.json');
const schema = readJsonObjectFile(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile<ReleaseConfig>(schema);

const builtinSlackWebhookPlugin = 'builtin:slack-webhook';
const builtinGitHubReleaseAssetsPlugin = 'builtin:github-release-assets';
const builtinNpmRegistryVerifyPlugin = 'builtin:npm-registry-verify';
const allowedPluginRefPrefixes = ['builtin:', 'npm:', 'path:'];

export class ConfigValidationError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

export function validateConfig(candidate: unknown): ReleaseConfig {
  if (!validate(candidate)) {
    const details = (validate.errors ?? []).map((error: { instancePath?: string; message?: string }) => {
      const pointer = error.instancePath || '/';
      return `${pointer} ${error.message ?? 'validation error'}`;
    });
    throw new ConfigValidationError('invalid release framework config', details);
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
    throw new ConfigValidationError('invalid release framework config', semanticErrors);
  }

  return config;
}

function validateVersioningConfig(config: ReleaseConfig): string[] {
  const errors: string[] = [];
  const source = config.version_source;
  const counterBasedTypes = new Set(['date-counter', 'backend-date-release', 'date-release']);
  const usesTemplateCounter = source.type === 'template'
    && typeof source.template === 'string'
    && source.template.includes('{counter}');

  const counterSource = typeof source.counter_source === 'string'
    ? source.counter_source
    : 'github-tag';

  const needsVisibleCounter = counterBasedTypes.has(source.type) || usesTemplateCounter;
  if (needsVisibleCounter && !containsAnyPlaceholder(config.tag_template, ['{version}', '{counter}'])) {
    errors.push('/tag_template counter-based versioning requires tag_template to include {version} or {counter}');
  }

  if (source.type === 'template' && typeof source.template === 'string' && source.template.includes('{version}')) {
    errors.push('/version_source/template custom version templates may not reference {version}; use concrete fields such as {date}, {counter}, {short_sha}, {sha}, {branch}, or {time}');
  }

  if (source.type === 'template' && typeof source.template === 'string') {
    errors.push(...validateTemplatePlaceholders('/version_source/template', source.template, ['date', 'counter', 'short_sha', 'sha', 'branch', 'time']));
  }

  errors.push(...validateTemplatePlaceholders('/tag_template', config.tag_template, ['version', 'date', 'counter', 'short_sha', 'sha', 'branch', 'time']));

  if (counterSource === 'explicit') {
    if (!isPositiveInteger(source.counter)) {
      errors.push('/version_source/counter explicit counter sources require version_source.counter to be a positive integer');
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
    : [`${pluginRef.path} plugin refs must start with builtin:, npm:, or path:`]);
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

function containsAnyPlaceholder(template: string, placeholders: string[]): boolean {
  return placeholders.some((placeholder) => template.includes(placeholder));
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isHttpsUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  return new URL(value).protocol === 'https:';
}
