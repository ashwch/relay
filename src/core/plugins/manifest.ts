import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import satisfies from 'semver/functions/satisfies.js';

/**
 * Plugin manifest validation.
 *
 * Think of a manifest as the plugin's contract card.
 * Before the runtime calls any plugin, it first asks:
 *
 * - what kind of plugin is this?
 * - which framework versions does it support?
 * - which permissions and secrets does it claim to need?
 * - which hooks should core expect it to implement?
 *
 * This file is where that contract gets checked.
 */

import { readJsonFile, readJsonObjectFile } from '../io/files.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type { PluginType } from './request-response.js';

interface PackageMetadata {
  version: string;
}

const packageJsonPath = path.resolve(import.meta.dirname, '../../../package.json');
const packageJson = readPackageMetadata(packageJsonPath);

// The currently running framework version is part of plugin compatibility.
// A manifest is not just "well-shaped"; it also has to say that it supports
// this framework build.
const FRAMEWORK_VERSION = packageJson.version;

const schemaPath = path.resolve(import.meta.dirname, '../../../schemas/plugin-manifest.schema.json');
const schema = readJsonObjectFile(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile<PluginManifest>(schema);

export interface PluginManifest {
  api_version: 'release-framework.plugin/v1';
  name: string;
  type: PluginType;
  plugin_version: string;
  plugin_api_version: 1;
  framework_version_range: string;
  entrypoint: {
    kind: 'builtin' | 'module' | 'path';
    handler: string;
  };
  capabilities: string[];
  supported_release_modes?: string[];
  config_schema?: string | null;
  required_inputs: string[];
  required_secrets: string[];
  optional_secrets: string[];
  permissions: JsonObject;
  supports: {
    dry_run: boolean;
    local: boolean;
    [key: string]: JsonValue;
  };
  outputs: string[];
  trust: {
    level: 'builtin' | 'first-party-package' | 'external-allowlisted' | 'local-path';
    allow_in_ci: boolean;
  };
}

export class PluginManifestError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

/**
 * Read one manifest file from disk, then validate both shape and version
 * compatibility.
 */
export function readManifest(manifestPath: string): PluginManifest {
  const absolutePath = path.resolve(manifestPath);
  const manifest = readJsonFile(absolutePath);
  return validateManifest(manifest);
}

/**
 * Validate one manifest object.
 *
 * There are two separate checks here:
 * 1. schema validation -> does the manifest have the right fields?
 * 2. compatibility     -> does the manifest claim it supports this framework?
 */
export function validateManifest(candidate: unknown): PluginManifest {
  if (!validate(candidate)) {
    const details = (validate.errors ?? []).map((error: { instancePath?: string; message?: string }) => `${error.instancePath || '/'} ${error.message ?? 'validation error'}`);
    throw new PluginManifestError('invalid plugin manifest', details);
  }
  const manifest = candidate;
  if (!satisfies(FRAMEWORK_VERSION, manifest.framework_version_range)) {
    throw new PluginManifestError('plugin is incompatible with framework version', [
      `${manifest.name} expects ${manifest.framework_version_range}, framework is ${FRAMEWORK_VERSION}`,
    ]);
  }
  return manifest;
}

function readPackageMetadata(filePath: string): PackageMetadata {
  const parsed = readJsonFile(filePath);
  if (!isPackageMetadata(parsed)) {
    throw new Error(`expected package metadata object in ${filePath}`);
  }
  return parsed;
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'version' in value
    && typeof value.version === 'string';
}
