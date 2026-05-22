import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Plugin loader.
 *
 * This file answers a very small but very important question:
 *
 *   "Given a plugin ref from config, what code and manifest are we actually
 *    willing to load for this run?"
 *
 * We keep the answer explicit on purpose.
 * That makes the framework easier to audit and keeps plugin loading from
 * becoming "magic discovery".
 */

import type { LoadedConfig } from '../config/types.js';
import { assertPluginAllowed } from './allowlist.js';
import { readManifest, type PluginManifest } from './manifest.js';
import { builtinHandlers, builtinManifestPaths } from './registry.js';
import type { PluginHandler, PluginType } from './request-response.js';

const require = createRequire(import.meta.url);

// Keep the built-in type list explicit and stable.
// It doubles as documentation for the first-class plugin categories the runtime
// understands today.
const builtinPluginTypes: PluginType[] = [
  'artifact_publisher',
  'metadata_enricher',
  'notifier',
  'profile',
  'provider',
  'release_tool',
];

export interface LoadedPlugin {
  manifest: PluginManifest;
  handler?: PluginHandler;
}

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolve one plugin ref into its validated manifest and, for built-ins, its
 * in-process handler.
 *
 * Visual resolution order:
 *
 *   builtin:... -> checked-in manifest + checked-in handler
 *   npm:...     -> allowlisted installed package + manifest only
 *   path:...    -> allowlisted local path + manifest only
 *
 * External plugin execution is intentionally not implemented yet.
 * For now, this function still validates those manifests so the contract can be
 * tested before the runtime grows more powerful.
 */
export function loadPlugin(loadedConfig: LoadedConfig, pluginRef: string, expectedType: PluginType): LoadedPlugin {
  if (pluginRef.startsWith('builtin:')) {
    const manifestPath = builtinManifestPaths[expectedType]?.[pluginRef];
    const handler = builtinHandlers[expectedType]?.[pluginRef];
    if (!manifestPath) {
      throw new PluginLoadError(`unknown built-in ${expectedType} plugin ${pluginRef}`);
    }
    const manifest = readManifest(manifestPath);
    if (manifest.type !== expectedType) {
      throw new PluginLoadError(`built-in plugin ${pluginRef} is type ${manifest.type}, expected ${expectedType}`);
    }
    if (!handler) {
      throw new PluginLoadError(`built-in plugin ${pluginRef} is missing a registered handler`);
    }
    return { manifest, handler };
  }

  assertPluginAllowed(loadedConfig, pluginRef);
  const manifestPath = resolveExternalManifestPath(loadedConfig, pluginRef);
  const manifest = readManifest(manifestPath);
  if (manifest.type !== expectedType) {
    throw new PluginLoadError(`plugin ${pluginRef} is type ${manifest.type}, expected ${expectedType}`);
  }
  return { manifest };
}

/**
 * List every built-in plugin the framework claims to ship.
 *
 * This is intentionally strict:
 * if a manifest exists without a handler, or a handler exists without a
 * matching manifest type, we fail instead of silently listing something broken.
 */
export function listBuiltinPlugins(): PluginManifest[] {
  return builtinPluginTypes.flatMap((pluginType) => {
    const entries = builtinManifestPaths[pluginType] ?? {};
    return Object.entries(entries).map(([ref, manifestPath]) => {
      const manifest = readManifest(manifestPath);
      if (manifest.type !== pluginType) {
        throw new PluginLoadError(`manifest ${ref} type mismatch`);
      }
      if (!builtinHandlers[pluginType]?.[ref]) {
        throw new PluginLoadError(`built-in plugin ${ref} is missing a registered handler`);
      }
      return manifest;
    });
  });
}

/**
 * Resolve the manifest path for a non-built-in plugin ref.
 *
 * Why manifest path resolution is separate from execution:
 * we want to validate and inspect external plugin contracts before we grant the
 * runtime permission to actually execute external code.
 */
function resolveExternalManifestPath(loadedConfig: LoadedConfig, pluginRef: string): string {
  if (pluginRef.startsWith('path:')) {
    const relativePath = pluginRef.slice('path:'.length);
    return path.resolve(loadedConfig.dir, relativePath, 'plugin-manifest.json');
  }
  if (pluginRef.startsWith('npm:')) {
    const packageName = pluginRef.slice('npm:'.length);
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
    const packageDir = path.dirname(packageJsonPath);
    const manifestPath = path.resolve(packageDir, 'plugin-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new PluginLoadError(`package plugin ${pluginRef} is missing plugin-manifest.json`);
    }
    return manifestPath;
  }
  throw new PluginLoadError(`unsupported plugin ref ${pluginRef}`);
}
