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

/**
 * One plugin after the framework has resolved its identity.
 *
 * Visual model:
 *
 *   pluginRef -> how config referred to it
 *   manifest  -> declared contract
 *   handler   -> built-in in-process implementation, if any
 *   rootDir   -> external plugin root directory, if any
 *
 * Why keep both `handler` and `rootDir` optional?
 * Because built-ins and external plugins take different execution paths, but
 * the rest of the framework still wants one small object that says
 * "this is the plugin we resolved for this phase".
 */
export interface LoadedPlugin {
  pluginRef: string;
  manifest: PluginManifest;
  handler?: PluginHandler;
  rootDir?: string;
}

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolve one plugin ref without requiring the caller to already know the
 * plugin type.
 *
 * Why this helper exists:
 * author-facing tooling such as `validate-plugin` often starts from the plugin
 * ref itself. At that stage we want to inspect the manifest first, then use the
 * manifest type as the source of truth for later checks.
 */
export function loadPluginForValidation(loadedConfig: LoadedConfig, pluginRef: string): LoadedPlugin {
  if (pluginRef.startsWith('builtin:')) {
    const matches = builtinPluginTypes.flatMap((pluginType) => {
      const manifestPath = builtinManifestPaths[pluginType]?.[pluginRef];
      const handler = builtinHandlers[pluginType]?.[pluginRef];
      return manifestPath && handler
        ? [{ pluginType, manifestPath, handler }]
        : [];
    });

    if (matches.length === 0) {
      throw new PluginLoadError(`unknown built-in plugin ${pluginRef}`);
    }
    if (matches.length > 1) {
      throw new PluginLoadError(`built-in plugin ${pluginRef} is ambiguous across multiple plugin types; validate it through a config entrypoint instead`);
    }

    const match = matches[0];
    const manifest = readManifest(match.manifestPath);
    return {
      pluginRef,
      manifest,
      handler: match.handler,
      rootDir: path.dirname(match.manifestPath),
    };
  }

  assertPluginAllowed(loadedConfig, pluginRef);
  const resolved = resolveExternalPluginLocation(loadedConfig, pluginRef);
  const manifest = readManifest(resolved.manifestPath);
  if (manifest.entrypoint.kind === 'builtin') {
    throw new PluginLoadError(`external plugin ${pluginRef} cannot declare entrypoint.kind=builtin`);
  }
  return {
    pluginRef,
    manifest,
    rootDir: resolved.rootDir,
  };
}

/**
 * Resolve one plugin ref into its validated manifest and, for built-ins, its
 * in-process handler.
 *
 * Visual resolution order:
 *
 *   builtin:... -> checked-in manifest + checked-in handler
 *   npm:...     -> allowlisted installed package + manifest + plugin root
 *   path:...    -> allowlisted local path + manifest + plugin root
 *
 * Why stop at plugin roots instead of executing here?
 * Because loading and execution are separate trust-boundary questions.
 * This file answers "what plugin contract are we talking about?"
 * The phase runner answers "how should that contract actually run?"
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
    return {
      pluginRef,
      manifest,
      handler,
      rootDir: path.dirname(manifestPath),
    };
  }

  const plugin = loadPluginForValidation(loadedConfig, pluginRef);
  if (plugin.manifest.type !== expectedType) {
    throw new PluginLoadError(`plugin ${pluginRef} is type ${plugin.manifest.type}, expected ${expectedType}`);
  }
  return plugin;
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
 * Resolve the manifest path and plugin root for a non-built-in plugin ref.
 *
 * Visual model:
 *
 *   plugin ref
 *      ↓
 *   plugin root directory
 *      ↓
 *   plugin-manifest.json
 *      ↓
 *   later: entrypoint handler inside that root
 *
 * Keeping the root explicit now makes subprocess execution easier to audit
 * later, because the runtime can enforce that handlers stay inside the plugin's
 * own directory.
 */
function resolveExternalPluginLocation(loadedConfig: LoadedConfig, pluginRef: string): { manifestPath: string; rootDir: string } {
  if (pluginRef.startsWith('path:')) {
    const relativePath = pluginRef.slice('path:'.length);
    const rootDir = path.resolve(loadedConfig.dir, relativePath);
    return {
      rootDir,
      manifestPath: path.resolve(rootDir, 'plugin-manifest.json'),
    };
  }
  if (pluginRef.startsWith('npm:')) {
    const packageName = pluginRef.slice('npm:'.length);
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
    const rootDir = path.dirname(packageJsonPath);
    const manifestPath = path.resolve(rootDir, 'plugin-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new PluginLoadError(`package plugin ${pluginRef} is missing plugin-manifest.json`);
    }
    return {
      rootDir,
      manifestPath,
    };
  }
  throw new PluginLoadError(`unsupported plugin ref ${pluginRef}`);
}
