import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';

import type { ReleaseConfig, ReleaseMode, VersionSource } from '../config/types.js';
import { versionSourceTypes } from '../version-source.js';
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
  schema_version: 'relay.release/v1';
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
  workspaceRoot: string;
}): Pick<NormalizedRelease, 'profile' | 'release' | 'completion' | 'notifications'> {
  const date = input.now.toISOString().slice(0, 10).replace(/-/g, '.');
  const version = resolveVersion(config, date, input.shortSha, input.workspaceRoot);
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
 *
 * This is the synchronous version resolver used during initial provider
 * normalization. It can resolve version sources that do not require async
 * context (file reads, env lookups, template substitution, git tag extraction).
 *
 * Sources that need async resolution (conventional-commits, changesets,
 * counter-based) fall back to `date-sha`. The async resolver in versioning.ts
 * always runs afterwards via applyResolvedReleaseIdentity and will override
 * the fallback with the correct value.
 */
export function resolveVersion(config: ReleaseConfig, date: string, shortSha: string, workspaceRoot: string): string {
  const source = config.version_source;
  const sourceType = source.type;

  if (sourceType === versionSourceTypes.date) {
    return date;
  }

  if (sourceType === versionSourceTypes.dateSha) {
    return `${date}-${shortSha}`;
  }

  if (sourceType === versionSourceTypes.explicit) {
    const explicit = readVersionSourceStringOption(source, 'value');
    if (explicit) {
      return explicit;
    }
  }

  if (sourceType === versionSourceTypes.file) {
    return resolveFileVersionSync(source, workspaceRoot);
  }

  if (sourceType === versionSourceTypes.template) {
    return resolveTemplateVersionSync(source, date, shortSha);
  }

  // All other types (conventional-commits, changesets, git-tag, env,
  // counter-based) need async resolution or runtime env context. Fall back to
  // date-sha; applyResolvedReleaseIdentity in versioning.ts will replace it
  // with the correct value.
  return `${date}-${shortSha}`;
}

function readVersionSourceStringOption(source: VersionSource, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readVersionSourceStringArrayOption(source: VersionSource, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter((v): v is string => typeof v === 'string');
  return result.length > 0 ? result : undefined;
}

function resolveFileVersionSync(source: VersionSource, workspaceRoot: string): string {
  const format = readVersionSourceStringOption(source, 'format');
  const filePath = readVersionSourceStringOption(source, 'path');
  const keyPath = readVersionSourceStringArrayOption(source, 'key_path');

  if (!format || !filePath || !keyPath || keyPath.length === 0) {
    throw new Error('version_source.type=file requires version_source.format, version_source.path, and version_source.key_path');
  }

  const resolvedPath = path.resolve(workspaceRoot, filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`version_source.type=file could not find ${resolvedPath}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`version_source.type=file failed to read ${resolvedPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    switch (format) {
      case 'json':
        parsed = JSON.parse(raw) as unknown;
        break;
      case 'yaml':
        parsed = YAML.parse(raw) as unknown;
        break;
      case 'toml':
        parsed = parseToml(raw) as unknown;
        break;
      default:
        throw new Error(`version_source.type=file does not support format ${format}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`version_source.type=file failed to parse ${format} file ${resolvedPath}: ${message}`);
  }

  let current: unknown = parsed;
  for (const segment of keyPath) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current as Record<string, unknown>, segment)) {
      throw new Error(`version_source.type=file could not find key_path ${keyPath.join('.')} in ${resolvedPath}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current !== 'string' || current.length === 0) {
    throw new Error(`version_source.type=file requires ${resolvedPath} -> ${keyPath.join('.')} to be a non-empty string`);
  }

  return current;
}

function resolveTemplateVersionSync(source: VersionSource, date: string, shortSha: string): string {
  const template = readVersionSourceStringOption(source, 'template');
  if (!template) {
    throw new Error('version_source.type=template requires version_source.template');
  }
  if (template.includes('{version}')) {
    throw new Error('version_source.type=template may not reference {version}; use concrete fields such as {date}, {counter}, or {short_sha} instead');
  }
  return applyTagTemplate(template, { date, short_sha: shortSha });
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
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
export function readNotificationDeliveryPolicy(options: JsonObject | undefined): NotificationTarget['delivery_policy'] {
  return options?.delivery_policy === 'always' ? 'always' : 'once';
}
