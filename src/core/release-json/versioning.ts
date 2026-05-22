import { createGitHubClient } from '../github/client.js';
import { listRepositoryTags, type RepositoryTagSummary } from '../github/tags.js';
import type { ReleaseConfig, VersionSource } from '../config/types.js';
import type { NormalizedRelease, TemplateValues } from './schema.js';
import { applyTagTemplate } from './schema.js';
import type { EnvMap } from '../types/runtime.js';

/**
 * Release identity resolution.
 *
 * This file exists because versioning is more than simple string formatting.
 * Some schemas are purely local, but others need repository context to stay
 * correct, especially when multiple releases can happen on the same day.
 *
 * Mental model:
 *
 *   version_source config
 *         +
 *   current repo/git context
 *         +
 *   optional existing tag history
 *         ↓
 *   one resolved version + one resolved tag
 */
export interface ResolvedReleaseIdentity {
  version: string;
  tag: string;
  name: string;
  body: string;
  idempotencyKey: string;
}

interface VersionContext {
  date: string;
  time: string;
  branch: string;
  shortSha: string;
  sha: string;
  counter?: number;
}

const githubTagCounterSource = 'github-tag';
const explicitCounterSource = 'explicit';
const dateReleaseSourceTypes = new Set(['backend-date-release', 'date-release']);
const counterSourceTypes = new Set(['date-counter', 'backend-date-release', 'date-release']);
const timeSourceType = 'date-time';
const templateSourceType = 'template';

export async function resolveReleaseIdentity(
  config: ReleaseConfig,
  release: NormalizedRelease,
  env: EnvMap,
): Promise<ResolvedReleaseIdentity> {
  const now = new Date();
  const date = formatDate(now);
  const time = formatTime(now, readTimePrecision(config.version_source));

  const counter = await resolveCounter(config, release, env, date);
  const context: VersionContext = {
    date,
    time,
    branch: release.git.ref_name,
    shortSha: release.git.short_sha,
    sha: release.git.sha,
    counter,
  };

  const version = resolveVersionFromSource(config.version_source, context);
  const tag = release.git.ref_type === 'tag'
    ? release.git.ref_name
    : applyTagTemplate(config.tag_template, buildTemplateValues(version, context));

  return {
    version,
    tag,
    name: `${config.product_name} ${version}`,
    body: `${config.product_name} release ${version}.`,
    idempotencyKey: `${release.repository.full_name}:${tag}`,
  };
}

function resolveVersionFromSource(source: VersionSource, context: VersionContext): string {
  if (source.type === 'date') {
    return context.date;
  }

  if (source.type === 'date-sha') {
    return `${context.date}-${context.shortSha}`;
  }

  if (source.type === timeSourceType) {
    const separator = readStringOption(source, 'separator') ?? '.';
    return `${context.date}${separator}${context.time}`;
  }

  if (source.type === 'explicit') {
    const explicit = readStringOption(source, 'value');
    if (!explicit) {
      throw new Error('version_source.type=explicit requires version_source.value');
    }
    return explicit;
  }

  if (source.type === templateSourceType) {
    const template = readStringOption(source, 'template');
    if (!template) {
      throw new Error('version_source.type=template requires version_source.template');
    }
    if (template.includes('{version}')) {
      throw new Error('version_source.type=template may not reference {version}; use concrete fields such as {date}, {counter}, or {short_sha} instead');
    }
    return applyTagTemplate(template, buildVersionTemplateValues(context));
  }

  if (counterSourceTypes.has(source.type)) {
    const counter = context.counter;
    if (!counter) {
      throw new Error(`version_source.type=${source.type} requires a resolved counter`);
    }

    const separator = readStringOption(source, 'separator') ?? '.';
    const padding = readNumberOption(source, 'padding') ?? 0;
    const omitCounterForFirst = dateReleaseSourceTypes.has(source.type)
      ? readBooleanOption(source, 'omit_counter_for_first') ?? true
      : readBooleanOption(source, 'omit_counter_for_first') ?? false;

    if (omitCounterForFirst && counter === 1) {
      return context.date;
    }

    return `${context.date}${separator}${String(counter).padStart(padding, '0')}`;
  }

  return `${context.date}-${context.shortSha}`;
}

async function resolveCounter(
  config: ReleaseConfig,
  release: NormalizedRelease,
  env: EnvMap,
  date: string,
): Promise<number | undefined> {
  const source = config.version_source;
  const needsCounter = counterSourceTypes.has(source.type) || templateNeedsCounter(source);
  if (!needsCounter) {
    return undefined;
  }

  const counterSource = readStringOption(source, 'counter_source') ?? githubTagCounterSource;
  if (counterSource === explicitCounterSource) {
    const explicitCounter = readNumberOption(source, 'counter');
    if (!explicitCounter || explicitCounter < 1) {
      throw new Error(`version_source.type=${source.type} with counter_source=explicit requires a positive version_source.counter`);
    }
    return explicitCounter;
  }

  if (counterSource !== githubTagCounterSource) {
    throw new Error(`unsupported version_source.counter_source=${counterSource}`);
  }

  return resolveCounterFromExistingTags(config, release, env, date);
}

async function resolveCounterFromExistingTags(
  config: ReleaseConfig,
  release: NormalizedRelease,
  env: EnvMap,
  date: string,
): Promise<number> {
  assertCounterDerivationSupported(config);

  const client = createGitHubClient({
    owner: release.repository.owner,
    name: release.repository.name,
  }, env);

  const tags = await listRepositoryTags(client);
  const startAt = readNumberOption(config.version_source, 'counter_start') ?? 1;
  const candidates = tags
    .map((tag) => parseRepositoryTag(tag, config, date))
    .filter((candidate): candidate is ParsedCounterCandidate => candidate !== null);

  for (const candidate of candidates) {
    if (candidate.commitSha === release.release.target_sha) {
      return candidate.counter;
    }
  }

  const highestCounter = candidates.reduce((maxCounter, candidate) => Math.max(maxCounter, candidate.counter), 0);
  return Math.max(startAt, highestCounter + 1);
}

interface ParsedCounterCandidate {
  counter: number;
  commitSha: string;
}

function parseRepositoryTag(
  tag: RepositoryTagSummary,
  config: ReleaseConfig,
  date: string,
): ParsedCounterCandidate | null {
  const tagFields = extractTemplateFields(config.tag_template, tag.name);
  if (!tagFields) {
    return null;
  }

  if (typeof tagFields.date === 'string' && tagFields.date !== date) {
    return null;
  }

  if (typeof tagFields.counter === 'string') {
    const parsedCounter = Number(tagFields.counter);
    if (!Number.isInteger(parsedCounter) || parsedCounter < 1) {
      return null;
    }
    return {
      counter: parsedCounter,
      commitSha: tag.commitSha,
    };
  }

  if (typeof tagFields.version !== 'string') {
    return null;
  }

  const parsedCounter = parseCounterFromVersion(config.version_source, tagFields.version, date);
  if (!parsedCounter) {
    return null;
  }

  return {
    counter: parsedCounter,
    commitSha: tag.commitSha,
  };
}

function parseCounterFromVersion(source: VersionSource, version: string, date: string): number | null {
  if (counterSourceTypes.has(source.type)) {
    const separator = readStringOption(source, 'separator') ?? '.';
    if (version === date && dateReleaseSourceTypes.has(source.type)) {
      return 1;
    }
    const prefix = `${date}${separator}`;
    if (!version.startsWith(prefix)) {
      return null;
    }
    const remainder = version.slice(prefix.length);
    if (!/^\d+$/.test(remainder)) {
      return null;
    }
    const parsedCounter = Number(remainder);
    return Number.isInteger(parsedCounter) && parsedCounter > 0 ? parsedCounter : null;
  }

  if (source.type === templateSourceType) {
    const template = readStringOption(source, 'template');
    if (!template) {
      return null;
    }
    const fields = extractTemplateFields(template, version);
    if (!fields || typeof fields.counter !== 'string') {
      return null;
    }
    if (typeof fields.date === 'string' && fields.date !== date) {
      return null;
    }
    const parsedCounter = Number(fields.counter);
    return Number.isInteger(parsedCounter) && parsedCounter > 0 ? parsedCounter : null;
  }

  return null;
}

function templateNeedsCounter(source: VersionSource): boolean {
  return source.type === templateSourceType
    && typeof readStringOption(source, 'template') === 'string'
    && readStringOption(source, 'template')?.includes('{counter}') === true;
}

function assertCounterDerivationSupported(config: ReleaseConfig): void {
  if (config.tag_template.includes('{counter}') || config.tag_template.includes('{version}')) {
    return;
  }

  throw new Error(
    'automatic counter-based versioning requires tag_template to include {version} or {counter} so existing tags can be interpreted',
  );
}

function buildTemplateValues(version: string, context: VersionContext): TemplateValues {
  return {
    ...buildVersionTemplateValues(context),
    version,
  };
}

function buildVersionTemplateValues(context: VersionContext): TemplateValues {
  const values: TemplateValues = {
    date: context.date,
    time: context.time,
    short_sha: context.shortSha,
    sha: context.sha,
    branch: context.branch,
  };

  if (context.counter !== undefined) {
    values.counter = String(context.counter);
  }

  return values;
}

function formatDate(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '.');
}

function formatTime(now: Date, precision: 'minutes' | 'seconds'): string {
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  if (precision === 'minutes') {
    return `${hours}${minutes}`;
  }

  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  return `${hours}${minutes}${seconds}`;
}

function readTimePrecision(source: VersionSource): 'minutes' | 'seconds' {
  const precision = readStringOption(source, 'time_precision');
  return precision === 'minutes' ? 'minutes' : 'seconds';
}

function readStringOption(source: VersionSource, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumberOption(source: VersionSource, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBooleanOption(source: VersionSource, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function extractTemplateFields(template: string, rendered: string): TemplateValues | null {
  const placeholderPattern = /\{([a-z_]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = placeholderPattern.exec(template);
  let expression = '^';

  while (match) {
    const [placeholder, key] = match;
    const literalSegment = template.slice(lastIndex, match.index);
    expression += escapeRegExp(literalSegment);
    expression += `(?<${key}>.+?)`;
    lastIndex = match.index + placeholder.length;
    match = placeholderPattern.exec(template);
  }

  expression += escapeRegExp(template.slice(lastIndex));
  expression += '$';

  const matcher = new RegExp(expression);
  const result = matcher.exec(rendered);
  if (!result?.groups) {
    return null;
  }

  return result.groups;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
