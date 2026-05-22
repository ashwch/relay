import { loadConfig } from '../../core/config/load-config.js';
import { resolveArtifactPublishers, resolveMetadataEnrichers, resolveNotifierSelections } from '../../core/config/resolve-plugin-config.js';
import { loadPlugin } from '../../core/plugins/loader.js';
import type { PluginManifest } from '../../core/plugins/manifest.js';
import type { LoadedConfig, VersionSource } from '../../core/config/types.js';

export interface InspectConfigOptions {
  config: string;
}

interface PhasePlanEntry {
  phase: string;
  plugin?: string;
  hooks: string[];
  note?: string;
}

interface VersioningInspection {
  source_type: string;
  tag_template: string;
  uses_counter: boolean;
  counter_source: string | null;
  automatic_counter_requires_github_tags: boolean;
  tag_template_supports_counter_derivation: boolean;
}

export async function runInspectConfigCommand(options: InspectConfigOptions): Promise<void> {
  const loaded = loadConfig(options.config);
  const provider = loadPlugin(loaded, loaded.config.provider_plugin, 'provider');
  const profile = loadPlugin(loaded, loaded.config.profile_plugin, 'profile');
  const tool = loaded.config.tool_plugin ? loadPlugin(loaded, loaded.config.tool_plugin, 'release_tool') : null;
  const notifiers = resolveNotifierSelections(loaded).map((selection) => loadPlugin(loaded, selection.plugin, 'notifier').manifest);
  const artifactPublishers = resolveArtifactPublishers(loaded).map((selection) => loadPlugin(loaded, selection.plugin, 'artifact_publisher').manifest);
  const metadataEnrichers = resolveMetadataEnrichers(loaded).map((selection) => loadPlugin(loaded, selection.plugin, 'metadata_enricher').manifest);

  const response = {
    config_path: loaded.path,
    release_mode: loaded.config.release_mode,
    release_profile: loaded.config.release_profile,
    versioning: inspectVersioning(loaded),
    phase_plan: buildPhasePlan({
      provider: provider.manifest,
      profile: profile.manifest,
      tool: tool?.manifest ?? null,
      artifactPublishers,
      metadataEnrichers,
      notifiers,
    }),
    provider: provider.manifest,
    profile: profile.manifest,
    tool: tool?.manifest ?? null,
    notifiers,
    artifact_publishers: artifactPublishers,
    metadata_enrichers: metadataEnrichers,
  };

  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

function inspectVersioning(loaded: LoadedConfig): VersioningInspection {
  const source = loaded.config.version_source;
  const usesCounter = versionSourceUsesCounter(source);
  const counterSource = usesCounter ? readStringOption(source, 'counter_source') ?? 'github-tag' : null;
  return {
    source_type: source.type,
    tag_template: loaded.config.tag_template,
    uses_counter: usesCounter,
    counter_source: counterSource,
    automatic_counter_requires_github_tags: usesCounter && counterSource === 'github-tag',
    tag_template_supports_counter_derivation: loaded.config.tag_template.includes('{version}') || loaded.config.tag_template.includes('{counter}'),
  };
}

function buildPhasePlan(input: {
  provider: PluginManifest;
  profile: PluginManifest;
  tool: PluginManifest | null;
  artifactPublishers: PluginManifest[];
  metadataEnrichers: PluginManifest[];
  notifiers: PluginManifest[];
}): PhasePlanEntry[] {
  return [
    {
      phase: 'normalize',
      plugin: input.provider.name,
      hooks: ['normalize'],
    },
    {
      phase: 'plan',
      plugin: input.profile.name,
      hooks: ['plan'],
    },
    ...(input.tool ? [{
      phase: 'release-tool',
      plugin: input.tool.name,
      hooks: input.tool.capabilities.includes('observe') ? ['observe'] : input.tool.capabilities,
    }] : []),
    {
      phase: 'release-record',
      hooks: [],
      note: 'core creates, updates, or observes the durable GitHub Release record',
    },
    ...input.artifactPublishers.map((manifest) => ({
      phase: 'artifact-phase',
      plugin: manifest.name,
      hooks: artifactHooks(manifest),
    })),
    ...input.metadataEnrichers.map((manifest) => ({
      phase: 'enrich',
      plugin: manifest.name,
      hooks: ['enrich'],
    })),
    ...input.notifiers.map((manifest) => ({
      phase: 'notify',
      plugin: manifest.name,
      hooks: ['render', 'notify'],
    })),
  ];
}

function artifactHooks(manifest: PluginManifest): string[] {
  const hooks: string[] = [];
  if (manifest.capabilities.some((capability) => capability === 'publish' || capability.startsWith('publish_'))) {
    hooks.push('publish');
  }
  if (manifest.capabilities.some((capability) => capability === 'verify' || capability.startsWith('verify_'))) {
    hooks.push('verify');
  }
  return hooks;
}

function versionSourceUsesCounter(source: VersionSource): boolean {
  return source.type === 'date-counter'
    || source.type === 'backend-date-release'
    || source.type === 'date-release'
    || (source.type === 'template' && readStringOption(source, 'template')?.includes('{counter}') === true);
}

function readStringOption(source: VersionSource, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
