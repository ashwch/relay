import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ReleaseType } from 'semver';
import inc from 'semver/functions/inc.js';
import parse from 'semver/functions/parse.js';
import rcompare from 'semver/functions/rcompare.js';

import { createGitHubClient } from '../github/client.js';
import { listRepositoryTags, type RepositoryTagSummary } from '../github/tags.js';
import type { ReleaseConfig, VersionSource } from '../config/types.js';
import {
  counterBasedVersionSourceTypes,
  dateReleaseSourceTypes,
  readVersionSourceBooleanOption,
  readVersionSourceNumberOption,
  readVersionSourceStringOption,
  templateUsesCounter,
  versionSourceTypes,
} from '../version-source.js';
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
  currentTag?: string;
  counter?: number;
}

// Everything the resolver may need beyond the normalized release document.
//
// Why this extra object exists:
// some version sources are pure formatting (`date-sha`), but others need to
// read files, inspect git history, or look at CI-provided environment values.
// Keeping those dependencies explicit makes it easier to audit which version
// sources are "local only" versus which ones inspect the wider workspace.
interface VersionRuntimeContext {
  config: ReleaseConfig;
  release: NormalizedRelease;
  env: EnvMap;
  workspaceRoot: string;
}

interface LocalSemverTag {
  name: string;
  version: string;
  commitSha: string;
}

const githubTagCounterSource = 'github-tag';
const explicitCounterSource = 'explicit';
const defaultInitialSemver = '0.1.0';
const defaultPackageJsonPath = 'package.json';
const defaultChangesetDirectory = '.changeset';
const defaultSemverIncrement: ReleaseType = 'patch';

// Semver inference sources need a stable rule when many signals are present.
//
// Visual model:
//
//   breaking change -> major
//   feat            -> minor
//   fix/perf/revert -> patch
//
// Higher priority always wins.
const semverIncrementPriority: Record<string, number> = {
  patch: 1,
  minor: 2,
  major: 3,
  prepatch: 1,
  preminor: 2,
  premajor: 3,
  prerelease: 1,
};

/**
 * Resolve the final version/tag/name/body that the rest of the finalize flow
 * should trust.
 *
 * First-principles rule:
 *
 *   one run
 *     -> one resolved version
 *     -> one resolved tag
 *     -> one idempotency key
 *
 * After this function runs, later phases should not need to care *why* a
 * version came from package.json, a git tag, Changesets, or commit history.
 */
export async function resolveReleaseIdentity(
  config: ReleaseConfig,
  release: NormalizedRelease,
  env: EnvMap,
  workspaceRoot: string,
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
    currentTag: release.git.ref_type === 'tag' ? release.git.ref_name : undefined,
    counter,
  };

  const version = await resolveVersionFromSource(config.version_source, context, {
    config,
    release,
    env,
    workspaceRoot,
  });
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

// One dispatcher for all built-in version source types.
//
// Why keep this as one obvious switch-like function?
// Future readers should be able to answer this question quickly:
//
//   "Given version_source.type=X, which codepath actually runs?"
//
// That is much easier to understand when the top-level routing stays flat and
// each helper below owns one source type.
async function resolveVersionFromSource(
  source: VersionSource,
  context: VersionContext,
  runtime: VersionRuntimeContext,
): Promise<string> {
  if (source.type === versionSourceTypes.date) {
    return context.date;
  }

  if (source.type === versionSourceTypes.dateSha) {
    return `${context.date}-${context.shortSha}`;
  }

  if (source.type === versionSourceTypes.dateTime) {
    const separator = readVersionSourceStringOption(source, 'separator') ?? '.';
    return `${context.date}${separator}${context.time}`;
  }

  if (source.type === versionSourceTypes.explicit) {
    const explicit = readVersionSourceStringOption(source, 'value');
    if (!explicit) {
      throw new Error('version_source.type=explicit requires version_source.value');
    }
    return explicit;
  }

  if (source.type === versionSourceTypes.packageJson) {
    return resolvePackageJsonVersion(source, runtime.workspaceRoot);
  }

  if (source.type === versionSourceTypes.env) {
    return resolveEnvVersion(source, runtime.env);
  }

  if (source.type === versionSourceTypes.gitTag) {
    return resolveGitTagVersion(source, context);
  }

  if (source.type === versionSourceTypes.conventionalCommits) {
    return resolveConventionalCommitVersion(source, runtime);
  }

  if (source.type === versionSourceTypes.changesets) {
    return resolveChangesetVersion(source, runtime);
  }

  if (source.type === versionSourceTypes.template) {
    const template = readVersionSourceStringOption(source, 'template');
    if (!template) {
      throw new Error('version_source.type=template requires version_source.template');
    }
    if (template.includes('{version}')) {
      throw new Error('version_source.type=template may not reference {version}; use concrete fields such as {date}, {counter}, or {short_sha} instead');
    }
    return applyTagTemplate(template, buildVersionTemplateValues(context));
  }

  if (counterBasedVersionSourceTypes.has(source.type)) {
    const counter = context.counter;
    if (!counter) {
      throw new Error(`version_source.type=${source.type} requires a resolved counter`);
    }

    const separator = readVersionSourceStringOption(source, 'separator') ?? '.';
    const padding = readVersionSourceNumberOption(source, 'padding') ?? 0;
    const omitCounterForFirst = dateReleaseSourceTypes.has(source.type)
      ? readVersionSourceBooleanOption(source, 'omit_counter_for_first') ?? true
      : readVersionSourceBooleanOption(source, 'omit_counter_for_first') ?? false;

    if (omitCounterForFirst && counter === 1) {
      return context.date;
    }

    return `${context.date}${separator}${String(counter).padStart(padding, '0')}`;
  }

  return `${context.date}-${context.shortSha}`;
}

// Observe the version that the package repo already declared.
//
// This is the recommended self-hosting path for Relay because npm publication,
// package.json, and GitHub release identity should all agree on the same final
// semver without Relay inventing a second source of truth.
function resolvePackageJsonVersion(source: VersionSource, workspaceRoot: string): string {
  const filePath = path.resolve(workspaceRoot, readVersionSourceStringOption(source, 'path') ?? defaultPackageJsonPath);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`version_source.type=package-json requires a non-empty version in ${filePath}`);
  }
  return parsed.version;
}

// Observe a version that some upstream system already resolved.
//
// Example mental model:
//
//   semantic-release / CI job / manual pipeline
//       ↓ exports RELEASE_VERSION
//   relay reads env
//       ↓
//   finalize continues with that exact version
function resolveEnvVersion(source: VersionSource, env: EnvMap): string {
  const key = readVersionSourceStringOption(source, 'key');
  if (!key) {
    throw new Error('version_source.type=env requires version_source.key');
  }

  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`version_source.type=env requires environment variable ${key}`);
  }

  return value;
}

// Observe a version directly from the current git tag.
//
// By default the whole tag becomes the version. If a pattern is provided,
// Relay extracts only the captured version part. This lets a repo keep tags
// like `v1.2.3` while still treating the logical version as `1.2.3`.
function resolveGitTagVersion(source: VersionSource, context: VersionContext): string {
  if (!context.currentTag) {
    throw new Error('version_source.type=git-tag requires the release ref to be a tag');
  }

  const pattern = readVersionSourceStringOption(source, 'pattern');
  if (!pattern) {
    return context.currentTag;
  }

  const match = new RegExp(pattern).exec(context.currentTag);
  if (!match) {
    throw new Error(`version_source.type=git-tag pattern did not match tag ${context.currentTag}`);
  }

  const version = match.groups?.version ?? match[1];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('version_source.type=git-tag pattern must capture the version as (?<version>...) or the first capture group');
  }

  return version;
}

// Infer the next semver from repository-native commit history.
//
// Visual model:
//
//   latest reachable semver tag
//          +
//   conventional commits since that tag
//          ↓
//   next semver
//
// We intentionally use *reachable* tags only. A higher tag on an unrelated
// branch must not silently change the version chosen for this commit.
function resolveConventionalCommitVersion(source: VersionSource, runtime: VersionRuntimeContext): string {
  return resolveDynamicSemverVersion(source, runtime, (latestTag) => {
    const commitMessages = readGitCommitMessages(runtime.workspaceRoot, latestTag.name, runtime.release.git.sha);
    return resolveHighestIncrement(commitMessages.map(resolveIncrementFromConventionalCommit))
      ?? readSemverIncrementOption(source, 'default_increment')
      ?? defaultSemverIncrement;
  });
}

// Infer the next semver from pending Changeset files.
//
// Visual model:
//
//   latest reachable semver tag
//          +
//   pending .changeset/*.md files for one package
//          ↓
//   next semver
//
// This keeps Relay compatible with repos that already use Changesets without
// requiring any Relay-specific PR labels or workflow conventions.
function resolveChangesetVersion(source: VersionSource, runtime: VersionRuntimeContext): string {
  return resolveDynamicSemverVersion(source, runtime, () => {
    const packageName = readChangesetPackageName(source, runtime.config);
    const changesetIncrement = resolveChangesetIncrement(
      path.resolve(runtime.workspaceRoot, readVersionSourceStringOption(source, 'directory') ?? defaultChangesetDirectory),
      packageName,
    );
    const increment = changesetIncrement ?? readSemverIncrementOption(source, 'default_increment');
    if (!increment) {
      throw new Error(`version_source.type=changesets found no pending changesets for ${packageName}`);
    }
    return increment;
  });
}

// Shared flow for semver-generating sources.
//
// Why this helper exists:
// conventional-commits and Changesets differ in how they decide the bump, but
// they share the same outer lifecycle:
//
//   find latest reachable semver tag
//      -> reuse it on reruns of the same commit
//      -> fall back to initial_version on first release
//      -> otherwise increment from that base tag
function resolveDynamicSemverVersion(
  source: VersionSource,
  runtime: VersionRuntimeContext,
  resolveIncrement: (latestTag: LocalSemverTag) => ReleaseType,
): string {
  const latestTag = findLatestLocalSemverTag(
    runtime.workspaceRoot,
    runtime.config.tag_template,
    readVersionSourceStringOption(source, 'tag_prefix') ?? '',
    runtime.release.git.sha,
  );
  if (latestTag?.commitSha === runtime.release.git.sha) {
    return latestTag.version;
  }

  if (!latestTag) {
    return readInitialSemver(source);
  }

  return incrementSemver(latestTag.version, resolveIncrement(latestTag), source.type);
}

async function resolveCounter(
  config: ReleaseConfig,
  release: NormalizedRelease,
  env: EnvMap,
  date: string,
): Promise<number | undefined> {
  const source = config.version_source;
  const needsCounter = counterBasedVersionSourceTypes.has(source.type) || templateUsesCounter(source);
  if (!needsCounter) {
    return undefined;
  }

  const counterSource = readVersionSourceStringOption(source, 'counter_source') ?? githubTagCounterSource;
  if (counterSource === explicitCounterSource) {
    const explicitCounter = readVersionSourceNumberOption(source, 'counter');
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
  const startAt = readVersionSourceNumberOption(config.version_source, 'counter_start') ?? 1;
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
  if (counterBasedVersionSourceTypes.has(source.type)) {
    const separator = readVersionSourceStringOption(source, 'separator') ?? '.';
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

  if (source.type === versionSourceTypes.template) {
    const template = readVersionSourceStringOption(source, 'template');
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

function readInitialSemver(source: VersionSource): string {
  return readVersionSourceStringOption(source, 'initial_version') ?? defaultInitialSemver;
}

function readChangesetPackageName(source: VersionSource, config: ReleaseConfig): string {
  const explicitPackage = readVersionSourceStringOption(source, 'package');
  if (explicitPackage) {
    return explicitPackage;
  }

  const configPackage = isRecord(config.package) && typeof config.package.name === 'string' && config.package.name.length > 0
    ? config.package.name
    : undefined;
  if (configPackage) {
    return configPackage;
  }

  throw new Error('version_source.type=changesets requires version_source.package or package.name');
}

function resolveChangesetIncrement(directory: string, packageName: string): ReleaseType | undefined {
  if (!fs.existsSync(directory)) {
    throw new Error(`version_source.type=changesets requires directory ${directory}`);
  }

  const increments = fs.readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.md') && fileName.toLowerCase() !== 'readme.md')
    .map((fileName) => readChangesetFrontmatter(path.join(directory, fileName)))
    .map((frontmatter) => frontmatter[packageName])
    .map((value) => normalizeChangesetIncrement(value))
    .filter((value): value is ReleaseType => value !== undefined);

  return resolveHighestIncrement(increments);
}

function readChangesetFrontmatter(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(raw);
  if (!match) {
    return {};
  }

  const parsed = YAML.parse(match[1]) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function normalizeChangesetIncrement(value: unknown): ReleaseType | undefined {
  return value === 'major' || value === 'minor' || value === 'patch' ? value : undefined;
}

function resolveIncrementFromConventionalCommit(message: string): ReleaseType | undefined {
  const subject = message.split(/\r?\n/, 1)[0] ?? '';
  if (/^.+(?:\(.+\))?!:/.test(subject) || /(^|\n)BREAKING CHANGE:/m.test(message)) {
    return 'major';
  }
  if (/^feat(?:\(.+\))?:/.test(subject)) {
    return 'minor';
  }
  if (/^(fix|perf|revert)(?:\(.+\))?:/.test(subject)) {
    return 'patch';
  }
  return undefined;
}

function resolveHighestIncrement(increments: Array<ReleaseType | undefined>): ReleaseType | undefined {
  let winner: ReleaseType | undefined;
  for (const increment of increments) {
    if (!increment) {
      continue;
    }
    if (!winner || semverIncrementPriority[increment] > semverIncrementPriority[winner]) {
      winner = increment;
    }
  }
  return winner;
}

function incrementSemver(version: string, increment: ReleaseType, sourceType: string): string {
  const incremented = inc(version, increment);
  if (!incremented) {
    throw new Error(`version_source.type=${sourceType} failed to increment ${version} with ${increment}`);
  }
  return incremented;
}

// Find the highest semver tag that is actually part of this commit's history.
//
// Why `--merged <sha>` matters:
//
//   main commit history      -> v0.1.0 -> feat commit
//   unrelated branch history -> v9.0.0
//
// When resolving a version for the main commit, v9.0.0 must be ignored.
function findLatestLocalSemverTag(workspaceRoot: string, tagTemplate: string, tagPrefix: string, targetSha: string): LocalSemverTag | null {
  const tags = readGitTagNames(workspaceRoot, targetSha)
    .map((tagName) => toLocalSemverTag(workspaceRoot, tagName, tagTemplate, tagPrefix))
    .filter((tag): tag is LocalSemverTag => tag !== null)
    .sort((left, right) => rcompare(left.version, right.version));
  return tags[0] ?? null;
}

// Convert one raw git tag into a semver-aware tag candidate.
//
// We try two strategies in order:
// 1. parse the tag back through tag_template when it exposes {version}
// 2. fall back to a simpler tag_prefix strip + semver parse
//
// That keeps semver inference aligned with how Relay itself renders tags.
function toLocalSemverTag(workspaceRoot: string, tagName: string, tagTemplate: string, tagPrefix: string): LocalSemverTag | null {
  const versionFromTemplate = readSemverVersionFromRenderedTag(tagTemplate, tagName);
  if (versionFromTemplate) {
    return {
      name: tagName,
      version: versionFromTemplate,
      commitSha: readGitTagCommitSha(workspaceRoot, tagName),
    };
  }

  if (!tagName.startsWith(tagPrefix)) {
    return null;
  }

  const parsed = parse(tagName.slice(tagPrefix.length));
  if (!parsed) {
    return null;
  }

  return {
    name: tagName,
    version: parsed.format(),
    commitSha: readGitTagCommitSha(workspaceRoot, tagName),
  };
}

function readGitTagNames(workspaceRoot: string, targetSha: string): string[] {
  const output = execGit(workspaceRoot, ['tag', '--merged', targetSha, '--list']);
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

// Reverse the rendered tag back into a semver string.
//
// Example:
//   tag_template = release-{version}
//   tag_name     = release-1.2.3
//   result       = 1.2.3
function readSemverVersionFromRenderedTag(tagTemplate: string, tagName: string): string | null {
  if (!tagTemplate.includes('{version}')) {
    return null;
  }

  const fields = extractTemplateFields(tagTemplate, tagName);
  if (!fields || typeof fields.version !== 'string') {
    return null;
  }

  const parsed = parse(fields.version);
  return parsed?.format() ?? null;
}

function readGitTagCommitSha(workspaceRoot: string, tagName: string): string {
  return execGit(workspaceRoot, ['rev-list', '-n', '1', tagName]).trim();
}

// Read the commit messages that occurred after the previous semver tag.
//
// We deliberately inspect subjects/bodies rather than PR metadata so Relay can
// adapt to repos that already follow conventional commits without needing extra
// labels or Relay-specific process changes.
function readGitCommitMessages(workspaceRoot: string, sinceTag: string, targetSha: string): string[] {
  const output = execGit(workspaceRoot, ['log', '--format=%B%x00', `${sinceTag}..${targetSha}`]);
  return output.split('\u0000').map((message) => message.trim()).filter((message) => message.length > 0);
}

function execGit(workspaceRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git command failed in ${workspaceRoot}: git ${args.join(' ')} (${message})`);
  }
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
  const precision = readVersionSourceStringOption(source, 'time_precision');
  return precision === 'minutes' ? 'minutes' : 'seconds';
}

function readSemverIncrementOption(source: VersionSource, key: string): ReleaseType | undefined {
  const value = readVersionSourceStringOption(source, key);
  return value === 'major' || value === 'minor' || value === 'patch' ? value : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
