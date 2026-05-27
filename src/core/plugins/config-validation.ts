import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import { readJsonObjectFile } from '../io/files.js';
import type { JsonObject } from '../types/json.js';
import type { LoadedPlugin } from './loader.js';
import type { PluginManifest } from './manifest.js';

// Schema validators are cached by absolute schema path.
//
// Why cache here?
// Plugin author tooling such as `validate-plugin`, plus later phase execution,
// may validate the same plugin config more than once in one process. Caching
// keeps those checks cheap without changing the contract.
const validatorCache = new Map<string, ValidateFunction<JsonObject>>();

// Small structured error for one author-facing question:
//
//   "what was wrong with this plugin config?"
//
// We keep details as a list of short strings because they surface cleanly in
// CLI output, tests, and future machine-readable wrappers.
export class PluginConfigValidationError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

/**
 * Validate one resolved plugin config against the plugin's own declared schema.
 *
 * Visual model:
 *
 *   repo config
 *      ↓ resolve plugin-specific options
 *   plugin config object
 *      ↓ optional plugin config schema
 *   validated plugin config
 *      ↓ only then run plugin hook
 *
 * Why do this before execution?
 * Because bad plugin config should fail at the contract boundary, not deep
 * inside plugin code after the runtime has already committed to a phase.
 */
export function validatePluginConfig<Value>(loadedPlugin: LoadedPlugin, pluginConfig: Value): Value {
  const schemaRef = loadedPlugin.manifest.config_schema;

  // No schema means "this plugin does not declare plugin-local config rules".
  //
  // Visual model:
  //
  //   no config_schema
  //        ↓
  //   nothing extra to validate here
  //        ↓
  //   return pluginConfig unchanged
  if (!schemaRef) {
    return pluginConfig;
  }
  if (!loadedPlugin.rootDir) {
    throw new PluginConfigValidationError(`plugin ${loadedPlugin.manifest.name} declares config_schema but has no plugin root`, []);
  }

  const schemaPath = resolvePluginSchemaPath(loadedPlugin.rootDir, schemaRef, loadedPlugin.manifest);
  const validate = loadSchemaValidator(schemaPath);

  // Why validate here instead of inside plugin code?
  //
  //   config object
  //        ↓
  //   framework contract check
  //        ↓
  //   only valid config reaches plugin execution
  //
  // That keeps failures early, small, and easier to explain.
  if (!validate(pluginConfig)) {
    const details = [
      `schema=${schemaPath}`,
      ...(validate.errors ?? []).map((error: { instancePath?: string; message?: string }) => `${error.instancePath || '/'} ${error.message ?? 'validation error'}`),
      'next_step=edit the plugin config JSON object or update config.schema.json so the expected fields and types match',
    ];
    throw new PluginConfigValidationError(`invalid config for plugin ${loadedPlugin.manifest.name}`, details);
  }

  return pluginConfig;
}

// Load and compile one plugin config schema.
//
// Visual model:
//
//   config.schema.json path
//          ↓
//     read JSON object
//          ↓
//     compile AJV validator
//          ↓
//      cache by path
//
// Why keep this helper separate?
// Because schema loading is a trust-boundary concern of its own.
// Future readers should be able to answer
//
//   "where do plugin config schemas come from?"
//
// without reading the higher-level validation flow.
function loadSchemaValidator(schemaPath: string): ValidateFunction<JsonObject> {
  const cached = validatorCache.get(schemaPath);
  if (cached) {
    return cached;
  }

  const schema = readJsonObjectFile(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile<JsonObject>(schema);
  validatorCache.set(schemaPath, validate);
  return validate;
}

// `config_schema` is allowed to point at a file inside the plugin root, but
// not outside it.
//
// Visual model:
//
//   allowlisted plugin root
//          ↓
//   config_schema may point inside here
//          ↓
//   but may not escape into unrelated workspace files
//
// Why enforce that?
// Because the plugin root is the allowlisted trust boundary. We do not want a
// plugin manifest to silently reach out and validate against unrelated files in
// the workspace.
function resolvePluginSchemaPath(pluginRoot: string, schemaRef: string, manifest: PluginManifest): string {
  const schemaPath = path.resolve(pluginRoot, schemaRef);
  const relativePath = path.relative(pluginRoot, schemaPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new PluginConfigValidationError(`plugin ${manifest.name} config_schema must stay inside plugin root`, [
      `plugin_root=${pluginRoot}`,
      `config_schema=${schemaRef}`,
    ]);
  }

  // Lexical containment is necessary but not sufficient.
  // A schema path inside the plugin root can still be a symlink whose real
  // target escapes into unrelated workspace files.
  if (fs.existsSync(schemaPath)) {
    const realPluginRoot = fs.realpathSync(pluginRoot);
    const realSchemaPath = fs.realpathSync(schemaPath);
    const realRelativePath = path.relative(realPluginRoot, realSchemaPath);
    if (realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
      throw new PluginConfigValidationError(`plugin ${manifest.name} config_schema must stay inside plugin root`, [
        `plugin_root=${pluginRoot}`,
        `config_schema=${schemaRef}`,
      ]);
    }
  }

  return schemaPath;
}
