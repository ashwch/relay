// Shared helpers for version_source config.
//
// Why centralize these?
// The same small facts show up in multiple places:
//
// - config validation
// - inspect-config presentation
// - release identity resolution
// - older schema-level fallback helpers
//
// Keeping the names and tiny predicates in one file reduces string drift and
// makes it easier to add a new version source without missing one callsite.
export const versionSourceTypes = {
  date: 'date',
  dateSha: 'date-sha',
  dateTime: 'date-time',
  dateCounter: 'date-counter',
  backendDateRelease: 'backend-date-release',
  dateRelease: 'date-release',
  template: 'template',
  explicit: 'explicit',
  packageJson: 'package-json',
  env: 'env',
  gitTag: 'git-tag',
  conventionalCommits: 'conventional-commits',
  changesets: 'changesets',
} as const;

export type VersionSourceType = typeof versionSourceTypes[keyof typeof versionSourceTypes];

interface VersionSourceLike {
  type: string;
  [key: string]: unknown;
}

export const dateReleaseSourceTypes: ReadonlySet<string> = new Set([
  versionSourceTypes.backendDateRelease,
  versionSourceTypes.dateRelease,
]);

export const counterBasedVersionSourceTypes: ReadonlySet<string> = new Set([
  versionSourceTypes.dateCounter,
  versionSourceTypes.backendDateRelease,
  versionSourceTypes.dateRelease,
]);

export const dynamicSemverVersionSourceTypes: ReadonlySet<string> = new Set([
  versionSourceTypes.conventionalCommits,
  versionSourceTypes.changesets,
]);

export function readVersionSourceStringOption(source: VersionSourceLike, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readVersionSourceNumberOption(source: VersionSourceLike, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readVersionSourceBooleanOption(source: VersionSourceLike, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function versionSourceUsesCounter(source: VersionSourceLike): boolean {
  return counterBasedVersionSourceTypes.has(source.type)
    || templateUsesCounter(source);
}

export function templateUsesCounter(source: VersionSourceLike): boolean {
  return source.type === versionSourceTypes.template
    && readVersionSourceStringOption(source, 'template')?.includes('{counter}') === true;
}
