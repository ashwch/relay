import type { LoadedConfig, ReleaseConfig } from '../config/types.js';

/**
 * This file holds the shared "final mile" for a release run.
 *
 * First principles:
 * - CI systems stay different.
 * - release tools stay different.
 * - this file is where they converge into one release document and one result.
 *
 * The code is intentionally staged so future readers can answer three questions quickly:
 * 1. How do we normalize input?
 * 2. When do plugins get to change the release document?
 * 3. When are notifications allowed to happen?
 */
import { loadConfig } from '../config/load-config.js';
import {
  resolveArtifactPluginConfig,
  resolveArtifactPublishers,
  resolveMetadataEnrichers,
  resolveNotifierPluginConfig,
  resolveNotifierSelections,
  resolvePluginConfig,
  resolveSelectionPluginConfig,
} from '../config/resolve-plugin-config.js';
import { createGitHubClient } from '../github/client.js';
import {
  ensureFrameworkManagedGitHubRelease,
  observeGitHubRelease,
  readNotificationMarker,
  writeNotificationMarker,
} from '../github/releases.js';
import { readJsonObjectFile } from '../io/files.js';
import { validateNormalizedRelease } from '../release-json/invariants.js';
import { applyMergePatch } from '../release-json/merge-patch.js';
import { readNotificationDeliveryPolicy, type NormalizedRelease } from '../release-json/schema.js';
import { resolveReleaseIdentity } from '../release-json/versioning.js';
import type { EnvMap, RuntimeArgs, StringMap, UnknownMap } from '../types/runtime.js';
import type { JsonObject } from '../types/json.js';
import { loadPlugin } from '../plugins/loader.js';
import { validatePluginConfig } from '../plugins/config-validation.js';
import type { PluginManifest } from '../plugins/manifest.js';
import { runPluginHook } from './phase-runner.js';
import type { FinalizeResult } from './outputs.js';

export interface RuntimeOptions {
  configPath: string;
  providerOverride?: string;
  profileOverride?: string;
  metadataPath?: string;
  dryRun: boolean;
  args: RuntimeArgs;
  env?: EnvMap;
  workspaceRoot?: string;
}

/**
 * Convert one provider-specific run into the shared release document.
 *
 * This command does not try to finish the release.
 * It only answers:
 * "What is the release state, in a CI-agnostic shape?"
 */
export async function normalizeReleaseDocument(options: RuntimeOptions): Promise<NormalizedRelease> {
  const loaded = loadEffectiveConfig(options.configPath, options.providerOverride, options.profileOverride);
  const env = options.env ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  const provider = loadPlugin(loaded, loaded.config.provider_plugin, 'provider');
  const normalized = (await runPluginHook({
    manifest: provider.manifest,
    handler: provider.handler,
    hook: 'normalize',
    dryRun: options.dryRun,
    pluginConfig: validatePluginConfig(provider, loaded.config),
    release: null,
    args: options.args,
    env,
    workspaceRoot,
    pluginRoot: provider.rootDir,
  })).release;

  if (!normalized) {
    throw new Error(`provider ${provider.manifest.name} did not return release JSON`);
  }

  let release = applyRefRuntimeOverrides(normalized, options.args, loaded.config.stable_branches);
  release = await applyResolvedReleaseIdentity(loaded.config, release, env, workspaceRoot);
  release = applyExplicitTagOverride(release, options.args);
  release = applyMetadata(release, options.metadataPath);
  return validateNormalizedRelease(release);
}

/**
 * Run the shared finalize flow.
 *
 * The implementation is intentionally simple right now:
 * - normalize input
 * - let the profile define completion semantics
 * - create, update, or observe the durable release record
 * - run artifact and metadata phases
 * - render or deliver notifications only when the completion gate allows it
 *
 * Plugin implementations can grow without changing this mental model.
 */
export async function finalizeRun(options: RuntimeOptions): Promise<FinalizeResult> {
  const loaded = loadEffectiveConfig(options.configPath, options.providerOverride, options.profileOverride);
  const env = options.env ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  // This array is intentionally explicit instead of being derived indirectly.
  // It acts as a readable run summary and records the actual ordering chosen by
  // the profile. Most profiles create/observe the GitHub Release first; package
  // profiles verify external visibility first so a failed package check does not
  // leave behind an early release record.
  const phases = ['resolve', 'normalize', 'plan', 'preflight'];

  // Step 1: provider-specific input becomes one shared release document.
  let release = await normalizeReleaseDocument(options);

  // Step 2: the profile answers "what does done mean for this repo type?"
  const profilePlugin = loadPlugin(loaded, loaded.config.profile_plugin, 'profile');
  const profilePluginConfig = validatePluginConfig(profilePlugin, resolvePluginConfig(loaded, loaded.config.profile_plugin));
  const planned = (await runPluginHook({
    manifest: profilePlugin.manifest,
    handler: profilePlugin.handler,
    hook: 'plan',
    dryRun: options.dryRun,
    pluginConfig: profilePluginConfig,
    release,
    args: options.args,
    env,
    workspaceRoot,
    pluginRoot: profilePlugin.rootDir,
  })).release;
  if (!planned) {
    throw new Error('profile plugin did not return release document');
  }
  release = validateNormalizedRelease(planned);

  if (release.profile.requires_tool_plugin && !loaded.config.tool_plugin) {
    throw new Error(`profile ${release.profile.name} requires tool_plugin`);
  }

  // Step 3: when another release tool owns the durable release record,
  // observe its result instead of creating a duplicate.
  //
  // Important no-op case:
  // semantic-release can exit successfully without creating a release. In that
  // case the tool plugin returns status=noop, and core stops before GitHub
  // verification, artifact work, and Slack delivery.
  let toolObserveNoop = false;
  if (loaded.config.release_mode === 'tool-observe' && loaded.config.tool_plugin) {
    const toolPlugin = loadPlugin(loaded, loaded.config.tool_plugin, 'release_tool');
    const toolPluginConfig = validatePluginConfig(toolPlugin, resolvePluginConfig(loaded, loaded.config.tool_plugin));
    const observedResult = await runPluginHook({
      manifest: toolPlugin.manifest,
      handler: toolPlugin.handler,
      hook: 'observe',
      dryRun: options.dryRun,
      pluginConfig: toolPluginConfig,
      release,
      args: options.args,
      env,
      workspaceRoot,
      pluginRoot: toolPlugin.rootDir,
    });
    const observed = observedResult.release;
    if (!observed) {
      throw new Error('tool plugin did not return release document');
    }
    release = validateNormalizedRelease(observed);
    toolObserveNoop = observedResult.response.status === 'noop';
  }

  if (toolObserveNoop) {
    phases.push('finalize');
    return buildFinalizeResult(release, options.dryRun, phases, 'noop');
  }

  // Step 4: choose the release-record/artifact ordering required by the profile.
  //
  // First-principles rule:
  //
  //   if external package/artifact visibility defines "complete"
  //     -> verify that external fact first
  //     -> create/update the GitHub Release only after it passes
  //
  // This matters for npm-package repos: a failed registry visibility check should
  // fail before relay creates a GitHub Release.
  if (shouldRunArtifactPhaseBeforeReleaseRecord(release)) {
    phases.push('artifact-phase', 'release-record');
    release = await runArtifactPhase(loaded, release, options, env, workspaceRoot);
    release = await ensureReleaseRecord(release, env, options.dryRun);
  } else {
    phases.push('release-record', 'artifact-phase');
    release = await ensureReleaseRecord(release, env, options.dryRun);
    release = await runArtifactPhase(loaded, release, options, env, workspaceRoot);
  }

  // Step 5: enrich after release and artifact/package facts have settled.
  phases.push('enrich');
  release = await runMetadataEnrichers(loaded, release, options, env, workspaceRoot);

  // Step 6: only deliver notifications after the completion gate is satisfied.
  phases.push('notify');
  release = await runConfiguredNotifications(loaded, release, options, env, workspaceRoot);
  release = validateNormalizedRelease(release);

  phases.push('finalize');
  return buildFinalizeResult(release, options.dryRun, phases, 'ok');
}

/**
 * Apply one-run overrides without mutating the checked-in repo config.
 *
 * Why this helper exists:
 * - migration work often needs temporary provider/profile overrides
 * - the repo config should still remain the durable default
 */
function loadEffectiveConfig(configPath: string, providerOverride?: string, profileOverride?: string): LoadedConfig {
  const loaded = loadConfig(configPath);
  const resolvedProfileOverride = resolveProfileOverride(profileOverride, loaded.config.profile_plugin);
  const config: ReleaseConfig = {
    ...loaded.config,
    provider_plugin: providerOverride ?? loaded.config.provider_plugin,
    release_profile: resolvedProfileOverride?.release_profile ?? loaded.config.release_profile,
    profile_plugin: resolvedProfileOverride?.profile_plugin ?? loaded.config.profile_plugin,
  };
  return {
    ...loaded,
    config,
  };
}

/**
 * Merge optional metadata into the normalized release document.
 *
 * We use merge-patch so callers can add small bits of context
 * without rebuilding the entire document.
 */
function applyMetadata(release: NormalizedRelease, metadataPath?: string): NormalizedRelease {
  if (!metadataPath) {
    return release;
  }
  const patch = readJsonObjectFile(metadataPath);
  return applyMergePatch(release, patch);
}

/**
 * Apply per-run CLI overrides.
 *
 * This is intentionally small and conservative.
 * If an override changes branch/ref semantics, we also update any dependent
 * fields such as stable/prerelease state so the document stays internally honest.
 *
 * Important example:
 * if `release_ref` points at `refs/tags/v1.2.3`, the durable release tag should
 * also become `v1.2.3` unless the caller explicitly overrides `--tag` later.
 */
function applyRefRuntimeOverrides(
  release: NormalizedRelease,
  args: RuntimeArgs,
  stableBranches: string[],
): NormalizedRelease {
  let next = release;
  const releaseRef = stringValue(args.release_ref);
  if (releaseRef) {
    const refName = releaseRef.replace(/^refs\/(heads|tags)\//, '');
    const refType = releaseRef.startsWith('refs/tags/') ? 'tag' : releaseRef.startsWith('refs/heads/') ? 'branch' : 'unknown';
    const stableBranch = stableBranches.includes(refName);
    const resolvedTag = refType === 'tag'
      ? refName
      : release.release.tag;

    next = applyMergePatch(next, {
      git: {
        ref: releaseRef,
        ref_name: refName,
        ref_type: refType,
        stable_branch: stableBranch,
      },
      release: {
        tag: resolvedTag,
        prerelease: !stableBranch,
        record: {
          idempotency_key: `${release.repository.full_name}:${resolvedTag}`,
        },
      },
    });
  }
  return next;
}

async function applyResolvedReleaseIdentity(
  config: ReleaseConfig,
  release: NormalizedRelease,
  env: EnvMap,
  workspaceRoot: string,
): Promise<NormalizedRelease> {
  const identity = await resolveReleaseIdentity(config, release, env, workspaceRoot);
  return applyMergePatch(release, {
    release: {
      version: identity.version,
      tag: identity.tag,
      name: identity.name,
      body: identity.body,
      record: {
        idempotency_key: identity.idempotencyKey,
      },
    },
  });
}

function applyExplicitTagOverride(release: NormalizedRelease, args: RuntimeArgs): NormalizedRelease {
  const explicitTag = stringValue(args.tag);
  if (!explicitTag) {
    return release;
  }

  return applyMergePatch(release, {
    release: {
      tag: explicitTag,
      record: {
        idempotency_key: `${release.repository.full_name}:${explicitTag}`,
      },
    },
  });
}

/**
 * Ensure the durable GitHub Release record exists in the right state.
 *
 * framework-managed:
 * - create or update the GitHub Release ourselves
 * - create the tag first if needed
 * - fail if an existing tag points at the wrong commit
 *
 * tool-observe:
 * - verify an existing GitHub Release already exists for the expected tag
 * - fail instead of creating a duplicate
 */
async function ensureReleaseRecord(
  release: NormalizedRelease,
  env: EnvMap,
  dryRun: boolean,
): Promise<NormalizedRelease> {
  const client = createGitHubClient({
    owner: release.repository.owner,
    name: release.repository.name,
  }, env);

  if (release.profile.release_mode === 'tool-wrap') {
    throw new Error('tool-wrap release mode is not implemented yet');
  }

  const result = release.profile.release_mode === 'framework-managed'
    ? await ensureFrameworkManagedGitHubRelease(client, {
      tag: release.release.tag,
      targetSha: release.release.target_sha,
      name: release.release.name,
      body: release.release.body,
      prerelease: release.release.prerelease,
    }, dryRun)
    : await observeGitHubRelease(client, release.release.tag, release.release.target_sha, dryRun);

  return applyMergePatch(release, {
    release: {
      url: result.url,
      published_at: result.publishedAt,
      record: {
        status: result.status,
      },
    },
  });
}

/**
 * Run artifact publishers and verifiers in configured order.
 *
 * Artifact plugins are allowed to publish or verify external assets/packages,
 * then patch artifact/package facts back into the release document if they own
 * those facts. Core only controls ordering and dry-run propagation.
 */
async function runArtifactPhase(
  loaded: LoadedConfig,
  release: NormalizedRelease,
  options: RuntimeOptions,
  env: EnvMap,
  workspaceRoot: string,
): Promise<NormalizedRelease> {
  let next = release;
  for (const publisher of resolveArtifactPublishers(loaded)) {
    const plugin = loadPlugin(loaded, publisher.plugin, 'artifact_publisher');
    const pluginConfig = validatePluginConfig(plugin, resolveArtifactPluginConfig(loaded, publisher));
    const secrets = resolvePluginSecrets(plugin.manifest, pluginConfig, env);
    const shouldPublish = shouldRunArtifactHook(plugin.manifest, 'publish');
    const shouldVerify = shouldRunArtifactHook(plugin.manifest, 'verify');

    if (!shouldPublish && !shouldVerify) {
      throw new Error(`artifact publisher ${plugin.manifest.name} declares no publish or verify hook`);
    }

    if (shouldPublish) {
      next = await runReleasePatchHook({
        loadedPlugin: plugin,
        hook: 'publish',
        dryRun: options.dryRun,
        pluginConfig,
        release: next,
        args: options.args,
        env,
        workspaceRoot,
        secrets,
      });
    }

    if (shouldVerify) {
      next = await runReleasePatchHook({
        loadedPlugin: plugin,
        hook: 'verify',
        dryRun: options.dryRun,
        pluginConfig,
        release: next,
        args: options.args,
        env,
        workspaceRoot,
        secrets,
      });
    }
  }
  return next;
}

/**
 * Run metadata enrichers after artifact facts have had a chance to settle.
 */
async function runMetadataEnrichers(
  loaded: LoadedConfig,
  release: NormalizedRelease,
  options: RuntimeOptions,
  env: EnvMap,
  workspaceRoot: string,
): Promise<NormalizedRelease> {
  let next = release;
  for (const enricher of resolveMetadataEnrichers(loaded)) {
    const plugin = loadPlugin(loaded, enricher.plugin, 'metadata_enricher');
    const pluginConfig = validatePluginConfig(plugin, resolveSelectionPluginConfig(loaded, enricher));
    next = await runReleasePatchHook({
      loadedPlugin: plugin,
      hook: 'enrich',
      dryRun: options.dryRun,
      pluginConfig,
      release: next,
      args: options.args,
      env,
      workspaceRoot,
      secrets: resolvePluginSecrets(plugin.manifest, pluginConfig, env),
    });
  }
  return next;
}

/**
 * Render or send notifier payloads after the release is truly complete.
 *
 * Important rule:
 * a published release record is not enough on its own.
 * Profiles such as asset-release may create the record before shipping is done,
 * so notification delivery must still honor completion.status.
 */
async function runConfiguredNotifications(
  loaded: LoadedConfig,
  release: NormalizedRelease,
  options: RuntimeOptions,
  env: EnvMap,
  workspaceRoot: string,
): Promise<NormalizedRelease> {
  if (release.completion.status !== 'completed' && !options.dryRun) {
    return release;
  }

  let next = release;
	  for (const notifier of resolveNotifierSelections(loaded)) {
	    const plugin = loadPlugin(loaded, notifier.plugin, 'notifier');
	    const pluginConfig = validatePluginConfig(plugin, resolveNotifierPluginConfig(loaded, notifier));
	    const secrets = resolvePluginSecrets(plugin.manifest, pluginConfig, env);
	    const markerKey = buildNotificationMarkerKey(notifier.plugin);
	    const deliveryPolicy = readNotificationDeliveryPolicy(notifier.options);
	    const forceNotify = readForceNotify(options.args);
	    let notificationMarker: Awaited<ReturnType<typeof readNotificationMarker>> = null;

	    if (!options.dryRun && deliveryPolicy === 'once') {
	      const client = createGitHubClient({
	        owner: next.repository.owner,
        name: next.repository.name,
      }, env);
      notificationMarker = await readNotificationMarker(client, next.release.tag, markerKey);
	      if (!notificationMarker) {
	        throw new Error(`cannot check notification marker for ${next.release.tag} because GitHub Release was not found`);
	      }
	      if (notificationMarker.exists && !forceNotify) {
	        next.notifications.deliveries.push({
	          plugin: notifier.plugin,
	          status: 'skipped',
          recorded_at: new Date().toISOString(),
          details: {
            reason: 'notification marker exists',
            marker_name: notificationMarker.markerName,
            marker_asset_url: notificationMarker.asset?.browser_download_url,
          },
        });
        continue;
      }
    }

    const rendered = await runPluginHook({
      manifest: plugin.manifest,
      handler: plugin.handler,
      hook: 'render',
      dryRun: options.dryRun,
      pluginConfig,
      release: next,
      args: options.args,
      env,
      workspaceRoot,
      secrets,
      pluginRoot: plugin.rootDir,
    });

    next = validateNormalizedRelease(rendered.release ?? next);
    const payload = rendered.response.outputs.payload;

    // Dry-run stops at render on purpose:
    // it should show the exact message shape without touching Slack or any
    // other downstream notification surface.
    if (options.dryRun) {
      next.notifications.deliveries.push({
        plugin: notifier.plugin,
        status: rendered.response.status === 'noop' ? 'skipped' : 'rendered',
        recorded_at: new Date().toISOString(),
        details: buildNotificationDetails(payload, undefined),
      });
      continue;
    }

    // Real runs still render first, then notify.
    // That keeps formatting and delivery separate and lets the delivery record
    // include both the previewable payload and side-effect metadata.
    const notified = await runPluginHook({
      manifest: plugin.manifest,
      handler: plugin.handler,
      hook: 'notify',
      dryRun: false,
      pluginConfig,
      release: next,
      args: options.args,
      env,
      workspaceRoot,
      secrets,
      pluginRoot: plugin.rootDir,
    });

    next = validateNormalizedRelease(notified.release ?? next);
    const sent = notified.response.status !== 'noop';
    if (sent && deliveryPolicy === 'once') {
      const client = createGitHubClient({
        owner: next.repository.owner,
        name: next.repository.name,
      }, env);
      if (!notificationMarker) {
        throw new Error(`cannot write notification marker for ${next.release.tag} because GitHub Release was not found`);
      }
      await writeNotificationMarker(client, notificationMarker, {
        plugin: notifier.plugin,
        release_tag: next.release.tag,
        release_url: next.release.url,
        delivery_status: notified.response.status,
        recorded_at: new Date().toISOString(),
      });
    }

    next.notifications.deliveries.push({
      plugin: notifier.plugin,
      status: sent ? 'sent' : 'skipped',
      recorded_at: new Date().toISOString(),
      details: buildNotificationDetails(payload, notified.response.outputs.delivery),
    });
  }
  return next;
}

interface ReleasePatchHookOptions {
  loadedPlugin: ReturnType<typeof loadPlugin>;
  hook: 'publish' | 'verify' | 'enrich';
  dryRun: boolean;
  pluginConfig: JsonObject;
  release: NormalizedRelease;
  args: RuntimeArgs;
  env: EnvMap;
  workspaceRoot: string;
  secrets: StringMap;
}

async function runReleasePatchHook(options: ReleasePatchHookOptions): Promise<NormalizedRelease> {
  const result = await runPluginHook({
    manifest: options.loadedPlugin.manifest,
    handler: options.loadedPlugin.handler,
    hook: options.hook,
    dryRun: options.dryRun,
    pluginConfig: options.pluginConfig,
    release: options.release,
    args: options.args,
    env: options.env,
    workspaceRoot: options.workspaceRoot,
    secrets: options.secrets,
    pluginRoot: options.loadedPlugin.rootDir,
  });
  return validateNormalizedRelease(result.release ?? options.release);
}

/**
 * Build the explicit secret bag passed across the plugin boundary.
 *
 * Plugins should not read process.env directly. Core gathers the named secrets
 * from the runtime environment, then hands plugins only the values their
 * manifests/config asked for. That keeps secrets easy to audit and makes future
 * out-of-process plugin execution possible.
 */
function resolvePluginSecrets(manifest: PluginManifest, pluginConfig: JsonObject, env: EnvMap): StringMap {
  const secretNames = new Set<string>([
    ...manifest.required_secrets,
    ...manifest.optional_secrets,
  ]);
  // Some notifiers let config choose the env/secret name.
  // For Slack, webhook_secret defaults to SLACK_WEBHOOK_URL but can be
  // overridden per repo or per notifier selection.
  const configuredSecretName = stringValue(pluginConfig.webhook_secret);
  if (configuredSecretName) {
    secretNames.add(configuredSecretName);
  }

  const secrets: StringMap = {};
  for (const secretName of secretNames) {
    const value = env[secretName];
    if (value && value.length > 0) {
      secrets[secretName] = value;
    }
  }
  return secrets;
}

function shouldRunArtifactHook(manifest: PluginManifest, hook: 'publish' | 'verify'): boolean {
  return manifest.hooks.includes(hook);
}

function shouldRunArtifactPhaseBeforeReleaseRecord(release: NormalizedRelease): boolean {
  return release.profile.release_record_timing === 'after_completion'
    && (release.profile.package_visibility_required === true || release.profile.artifact_completion_required === true);
}

function buildNotificationDetails(payload: unknown, delivery: unknown): UnknownMap | undefined {
  const details: UnknownMap = {};
  if (payload && typeof payload === 'object') {
    details.payload = payload;
  }
  if (delivery && typeof delivery === 'object') {
    details.delivery = delivery;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function buildNotificationMarkerKey(pluginRef: string): string {
  return pluginRef.replace(/^builtin:/, '');
}

function readForceNotify(args: RuntimeArgs): boolean {
  return args.force_notify === true;
}

function buildFinalizeResult(
  release: NormalizedRelease,
  dryRun: boolean,
  phases: string[],
  status: FinalizeResult['status'],
): FinalizeResult {
  return {
    status,
    release_tag: release.release.tag,
    release_url: release.release.url,
    release_mode: release.profile.release_mode,
    profile: release.profile.name,
    notification_sent: release.notifications.deliveries.some((delivery) => delivery.status === 'sent'),
    dry_run: dryRun,
    normalized_release: release,
    phases,
  };
}

/**
 * Translate a human-friendly profile override into the concrete plugin ref that
 * should implement it.
 *
 * Example:
 * --release-profile asset-release
 * becomes
 * release_profile=asset-release + profile_plugin=builtin:asset-release
 */
function resolveProfileOverride(profileOverride: string | undefined, currentProfilePlugin: string): { release_profile: string; profile_plugin: string } | null {
  if (!profileOverride) {
    return null;
  }

  if (profileOverride.startsWith('builtin:')) {
    const profileName = profileOverride.slice('builtin:'.length);
    return {
      release_profile: profileName,
      profile_plugin: profileOverride,
    };
  }

  if (currentProfilePlugin.startsWith('builtin:')) {
    return {
      release_profile: profileOverride,
      profile_plugin: `builtin:${profileOverride}`,
    };
  }

  return {
    release_profile: profileOverride,
    profile_plugin: currentProfilePlugin,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
