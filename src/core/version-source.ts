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
  file: 'file',
  env: 'env',
  gitTag: 'git-tag',
  conventionalCommits: 'conventional-commits',
  changesets: 'changesets',
} as const;

// Generic file-backed versioning is intentionally small.
//
// Mental model:
//
//   one structured file
//      + one parser choice
//      + one key_path
//      ↓
//   one observed version string
//
// We keep the supported formats here so schema, validation, and runtime all use
// the same tiny source of truth.
export const fileVersionSourceFormats = {
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
} as const;

export type VersionSourceType = typeof versionSourceTypes[keyof typeof versionSourceTypes];
export type FileVersionSourceFormat = typeof fileVersionSourceFormats[keyof typeof fileVersionSourceFormats];

const fileVersionSourceFormatValues: ReadonlySet<string> = new Set(Object.values(fileVersionSourceFormats));

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

// `key_path` is array-based on purpose.
//
// Why not dotted strings like `project.version`?
// - no ambiguity around literal dots in keys
// - simpler validation
// - simpler future extension if Relay ever needs richer path semantics
export function readVersionSourceStringArrayOption(source: VersionSourceLike, key: string): string[] | undefined {
  const value = source[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
    ? value
    : undefined;
}

export function isFileVersionSourceFormat(value: string): value is FileVersionSourceFormat {
  return fileVersionSourceFormatValues.has(value);
}

export function versionSourceUsesCounter(source: VersionSourceLike): boolean {
  return counterBasedVersionSourceTypes.has(source.type)
    || templateUsesCounter(source);
}

export function templateUsesCounter(source: VersionSourceLike): boolean {
  return source.type === versionSourceTypes.template
    && readVersionSourceStringOption(source, 'template')?.includes('{counter}') === true;
}
