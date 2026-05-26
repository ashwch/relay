import type { ReleaseConfig, ReleaseMode } from '../config/types.js';
import type { JsonObject } from '../types/json.js';
import type { UnknownMap } from '../types/runtime.js';

/**
 * Normalized release document types.
 *
 * This file defines the shared shape that the whole framework tries to protect.
 *
 * First principles:
 * - providers should emit this shape
 * - profile/tool/metadata/notifier logic should patch this shape
 * - callers should be able to trust this shape as the framework's main
 *   machine-readable output
 */

/**
 * Which notifier should be considered for this run, and under what policy.
 */
export interface NotificationTarget {
  plugin: string;
  enabled: boolean;
  delivery_policy: 'once' | 'always';
  options?: JsonObject;
}

/**
 * Append-only record of what happened when a notifier was considered.
 */
export interface DeliveryRecord {
  plugin: string;
  status: 'sent' | 'skipped' | 'rendered';
  recorded_at: string;
  details?: UnknownMap;
}

/**
 * The central release document.
 *
 * Mental model:
 *
 *   run/source/repository/git -> where this release context came from
 *   profile/release           -> what this release should be
 *   completion                -> whether shipping is really done
 *   notifications             -> what message work was considered
 *   links/extensions          -> extra useful context
 */
export interface NormalizedRelease {
  schema_version: 'release-framework.release/v1';
  run: {
    id: string;
    dry_run: boolean;
    provider: string;
    trigger: string;
  };
  source: JsonObject;
  repository: {
    owner: string;
    name: string;
    full_name: string;
    default_branch?: string;
    url: string;
  };
  git: {
    ref: string;
    ref_name: string;
    ref_type: 'branch' | 'tag' | 'unknown';
    sha: string;
    short_sha: string;
    stable_branch: boolean;
    commit_timestamp?: string | null;
  };
  profile: {
    name: string;
    release_mode: ReleaseMode;
    completion_gate: string;
    release_record_timing: 'after_completion' | 'at_completion' | 'before_artifacts';
    channel?: string;
    requires_tool_plugin?: boolean;
    artifact_completion_required?: boolean;
    package_visibility_required?: boolean;
  };
  release: {
    version: string;
    tag: string;
    name: string;
    body: string;
    prerelease: boolean;
    target_sha: string;
    published_at: string | null;
    url: string | null;
    record: {
      system: 'github';
      owner: 'core' | 'tool' | 'external';
      status: 'pending' | 'observed' | 'created' | 'updated' | 'noop';
      idempotency_key: string;
    };
  };
  completion: {
    status: 'pending' | 'completed' | 'failed' | 'unknown';
    completed_at: string | null;
    evidence: JsonObject[];
  };
  artifacts: JsonObject[];
  packages: JsonObject[];
  pull_requests: JsonObject[];
  notifications: {
    targets: NotificationTarget[];
    deliveries: DeliveryRecord[];
  };
  links: UnknownMap;
  extensions: UnknownMap;
}

/**
 * Build the release fields that are stable across providers.
 *
 * Providers still own source-specific context, but version/tag/name/body and
 * baseline notification targets come from shared framework rules.
 */
export function buildCoreReleaseFields(config: ReleaseConfig, input: {
  owner: string;
  repo: string;
  sha: string;
  shortSha: string;
  refName: string;
  stableBranch: boolean;
  completionStatus?: NormalizedRelease['completion']['status'];
  dryRun: boolean;
  providerPlugin: string;
  trigger: string;
  now: Date;
}): Pick<NormalizedRelease, 'profile' | 'release' | 'completion' | 'notifications'> {
  const date = input.now.toISOString().slice(0, 10).replace(/-/g, '.');
  const version = resolveVersion(config, date, input.shortSha);
  const tag = applyTagTemplate(config.tag_template, {
    date,
    short_sha: input.shortSha,
    sha: input.sha,
    version,
    branch: input.refName,
  });
  const releaseModeOwner = config.release_mode === 'framework-managed' ? 'core' : 'tool';

  return {
    profile: {
      name: config.release_profile,
      release_mode: config.release_mode,
      completion_gate: 'unspecified',
      release_record_timing: 'after_completion',
    },
    release: {
      version,
      tag,
      name: `${config.product_name} ${version}`,
      body: `${config.product_name} release ${version}.`,
      prerelease: !input.stableBranch,
      target_sha: input.sha,
      published_at: null,
      url: null,
      record: {
        system: 'github',
        owner: releaseModeOwner,
        status: 'pending',
        idempotency_key: `${input.owner}/${input.repo}:${tag}`,
      },
    },
    completion: {
      status: input.completionStatus ?? 'completed',
      completed_at: input.completionStatus === 'completed' || input.completionStatus === undefined ? input.now.toISOString() : null,
      evidence: [],
    },
    notifications: {
      targets: (config.notifiers ?? []).map((selection) => {
        const plugin = typeof selection === 'string' ? selection : selection.plugin;
        const options = typeof selection === 'string' ? undefined : selection.options;
        return {
          plugin,
          enabled: true,
          delivery_policy: readNotificationDeliveryPolicy(options),
          ...(options ? { options } : {}),
        } satisfies NotificationTarget;
      }),
      deliveries: [],
    },
  };
}

/**
 * Resolve a version string from the configured version policy.
 */
export function resolveVersion(config: ReleaseConfig, date: string, shortSha: string): string {
  const sourceType = config.version_source.type;
  if (sourceType === 'date') {
    return date;
  }
  if (sourceType === 'date-sha') {
    return `${date}-${shortSha}`;
  }
  if (sourceType === 'explicit') {
    const explicit = config.version_source.value;
    if (typeof explicit === 'string' && explicit.length > 0) {
      return explicit;
    }
  }
  return `${date}-${shortSha}`;
}

/**
 * Apply simple placeholder substitution for tag templates.
 *
 * Example:
 * production-{date}-{short_sha}
 * → production-2026.05.22-9f3c1d2
 */
export interface TemplateValues {
  [key: string]: string;
}

export function applyTagTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}

/**
 * Keep the normalized release target honest about runtime notifier behavior.
 *
 * Visual rule:
 *
 *   missing or unknown delivery_policy -> once
 *   delivery_policy: always           -> always
 *
 * Core uses the same rule during notification delivery, so the release document
 * and the runtime path tell the same story.
 */
function readNotificationDeliveryPolicy(options: JsonObject | undefined): NotificationTarget['delivery_policy'] {
  return options?.delivery_policy === 'always' ? 'always' : 'once';
}
