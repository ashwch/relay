import path from 'node:path';

/**
 * Smoke tests for the framework's static contract surface.
 *
 * If these fail, the framework may no longer be able to read its own config or
 * discover the built-in plugins it claims to ship.
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/core/config/load-config.js';
import { resolveNotifierPluginConfig } from '../src/core/config/resolve-plugin-config.js';
import { ConfigValidationError, validateConfig } from '../src/core/config/validate-config.js';
import { listBuiltinPlugins } from '../src/core/plugins/loader.js';

const fixturePath = path.resolve(import.meta.dirname, 'fixtures/relay.yml');

describe('config loading', () => {
  it('loads and validates the release config fixture', () => {
    const loaded = loadConfig(fixturePath);
    expect(loaded.config.product_name).toBe('Example Web App');
    expect(loaded.config.profile_plugin).toBe('builtin:deploy-release');
  });

  it('merges Slack convenience config into notifier plugin config', () => {
    const loaded = loadConfig(fixturePath);
    const pluginConfig = resolveNotifierPluginConfig(loaded, {
      plugin: 'builtin:slack-webhook',
      options: {
        webhook_secret: 'OVERRIDE_SLACK_WEBHOOK',
      },
    });

    expect(pluginConfig).toMatchObject({
      enabled: true,
      include_rollout_prompt: true,
      webhook_secret: 'OVERRIDE_SLACK_WEBHOOK',
    });
  });

  it('lists builtin manifests', () => {
    const manifests = listBuiltinPlugins();
    expect(manifests.some((manifest) => manifest.name === 'builtin:github-actions' && manifest.type === 'provider')).toBe(true);
    expect(manifests.some((manifest) => manifest.name === 'builtin:semantic-release' && manifest.type === 'release_tool')).toBe(true);
    expect(manifests.some((manifest) => manifest.name === 'builtin:github-release-assets' && manifest.type === 'artifact_publisher')).toBe(true);
    expect(manifests.some((manifest) => manifest.name === 'builtin:github-associated-prs' && manifest.type === 'metadata_enricher')).toBe(true);
  });

  it('accepts richer built-in version source schemas', () => {
    expect(validateConfig(buildConfig({ version_source: { type: 'date-time', separator: '.', time_precision: 'seconds' } })).version_source.type).toBe('date-time');
    expect(validateConfig(buildConfig({ version_source: { type: 'date-counter', counter_source: 'explicit', counter: 2, separator: '.' } })).version_source.type).toBe('date-counter');
    expect(validateConfig(buildConfig({ version_source: { type: 'backend-date-release', counter_source: 'github-tag', separator: '.' } })).version_source.type).toBe('backend-date-release');
    expect(validateConfig(buildConfig({ version_source: { type: 'template', template: '{date}.{counter}-{short_sha}', counter_source: 'explicit', counter: 4 } })).version_source.type).toBe('template');
    expect(validateConfig(buildConfig({ version_source: { type: 'explicit', value: '2026.05.22.7' } })).version_source.type).toBe('explicit');
  });

  it('rejects counter-based versioning that hides the counter from tags', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'backend-date-release',
        counter_source: 'github-tag',
      },
      tag_template: 'stable-release',
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects recursive template version references', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'template',
        template: '{version}-{short_sha}',
        counter_source: 'explicit',
        counter: 1,
      },
      tag_template: 'release-{version}',
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects explicit counter sources without a counter value', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'date-counter',
        counter_source: 'explicit',
      },
      tag_template: 'release-{version}',
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects plugin refs without an explicit source prefix', () => {
    expect(() => validateConfig(buildConfig({
      provider_plugin: 'github-actions',
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects release modes with inconsistent tool plugin ownership', () => {
    expect(() => validateConfig(buildConfig({
      release_mode: 'tool-observe',
      tool_plugin: null,
    }))).toThrowError(ConfigValidationError);

    expect(() => validateConfig(buildConfig({
      release_mode: 'framework-managed',
      tool_plugin: 'builtin:semantic-release',
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects enabled Slack config without the Slack notifier', () => {
    expect(() => validateConfig(buildConfig({
      slack: {
        enabled: true,
        webhook_secret: 'SLACK_WEBHOOK_URL',
      },
      notifiers: [],
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects malformed or unsupported template placeholders', () => {
    expect(() => validateConfig(buildConfig({
      tag_template: 'release-{version2}',
    }))).toThrowError(ConfigValidationError);

    expect(() => validateConfig(buildConfig({
      tag_template: 'release-{version',
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects allowlisted plugin refs without explicit source prefixes', () => {
    expect(() => validateConfig(buildConfig({
      plugin_allowlist: ['local-plugin'],
    }))).toThrowError(ConfigValidationError);
  });
});

function buildConfig(overrides: Partial<ReturnType<typeof loadConfig>['config']>): ReturnType<typeof loadConfig>['config'] {
  return {
    api_version: 1,
    product_name: 'Example Service',
    release_profile: 'deploy-release',
    release_mode: 'framework-managed',
    provider_plugin: 'builtin:generic-env',
    profile_plugin: 'builtin:deploy-release',
    tool_plugin: null,
    artifact_publishers: [],
    notifiers: [],
    metadata_enrichers: [],
    plugin_allowlist: [],
    allow_local_plugins: false,
    stable_branches: ['main'],
    version_source: {
      type: 'date-sha',
    },
    tag_template: 'release-{version}',
    notes_source: {
      type: 'static',
    },
    plugin_config: {},
    ...overrides,
  };
}
