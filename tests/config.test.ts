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
import type { ReleaseConfig } from '../src/core/config/types.js';
import { listBuiltinPlugins } from '../src/core/plugins/loader.js';

const fixturePath = path.resolve(import.meta.dirname, 'fixtures/relay.yml');
const gitPluginRef = 'git:github.com/ashwch/relay-plugins//monolith-notify@main';

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
    expect(validateConfig(buildConfig({ version_source: { type: 'file', format: 'json', path: 'package.json', key_path: ['version'] } })).version_source.type).toBe('file');
    expect(validateConfig(buildConfig({ version_source: { type: 'env', key: 'RELEASE_VERSION' } })).version_source.type).toBe('env');
    expect(validateConfig(buildConfig({ version_source: { type: 'git-tag', pattern: '^v(?<version>.+)$' } })).version_source.type).toBe('git-tag');
    expect(validateConfig(buildConfig({ version_source: { type: 'conventional-commits', tag_prefix: 'v', initial_version: '0.1.0', default_increment: 'patch' } })).version_source.type).toBe('conventional-commits');
    expect(validateConfig(buildConfig({ version_source: { type: 'changesets', directory: '.changeset', package: '@example/component-library', tag_prefix: 'v', initial_version: '0.1.0' } })).version_source.type).toBe('changesets');
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

  it('rejects env version sources without a key', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'env',
      },
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects invalid file version source shapes', () => {
    expect(readValidationDetails(() => validateConfig(buildConfig({
      version_source: {
        type: 'file',
        format: 'ini',
        path: 'package.json',
        key_path: ['version'],
      },
    })))).toContain('/version_source/format file version sources require version_source.format to be one of: json, yaml, toml');

    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'file',
        format: 'json',
        path: '',
        key_path: ['version'],
      },
    }))).toThrowError(ConfigValidationError);

    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'file',
        format: 'json',
        path: 'package.json',
        key_path: [],
      },
    }))).toThrowError(ConfigValidationError);

    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'file',
        format: 'json',
        path: 'package.json',
        key_path: ['version', ''],
      },
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects removed package-json version source configs', () => {
    const candidate = {
      ...buildConfig({}),
      version_source: {
        type: 'package-json',
        path: 'package.json',
      },
    };

    expect(readValidationDetails(() => validateConfig(candidate))).toContain(
      '/version_source/type package-json has been removed; use version_source.type=file with format=json, path=package.json, and key_path=[version]',
    );
  });

  it('rejects invalid git-tag extraction regexes', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'git-tag',
        pattern: '[',
      },
    }))).toThrowError(ConfigValidationError);

    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'git-tag',
        pattern: '^v.+$',
      },
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects dynamic semver sources whose tags do not expose the version', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'conventional-commits',
        tag_prefix: 'v',
      },
      tag_template: 'stable-release',
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects invalid semver defaults for dynamic semver sources', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'conventional-commits',
        initial_version: 'not-semver',
      },
    }))).toThrowError(ConfigValidationError);

    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'changesets',
        package: '@example/component-library',
        default_increment: 'prerelease',
      },
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects changesets sources without a package name', () => {
    expect(() => validateConfig(buildConfig({
      version_source: {
        type: 'changesets',
      },
    }))).toThrowError(ConfigValidationError);
  });

  it('rejects plugin refs without an explicit source prefix', () => {
    expect(() => validateConfig(buildConfig({
      provider_plugin: 'github-actions',
    }))).toThrowError(ConfigValidationError);
  });

  it('accepts git plugin refs in plugin config and allowlists', () => {
    expect(validateConfig(buildConfig({
      metadata_enrichers: [gitPluginRef],
      plugin_allowlist: [gitPluginRef],
    })).metadata_enrichers).toEqual([gitPluginRef]);
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

function readValidationDetails(callback: () => unknown): string[] {
  try {
    callback();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.details;
    }
    throw error;
  }

  throw new Error('expected config validation to fail');
}

function buildConfig(overrides: Partial<ReleaseConfig>): ReleaseConfig {
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
