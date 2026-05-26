import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { maxPluginResponseBytes } from '../constants.js';
import { readJsonObjectFile } from '../io/files.js';
import type { JsonObject } from '../types/json.js';
import type { PluginResponse, ValidatedPluginResponse } from './request-response.js';

// This validator protects the boundary between plugin code and core.
//
// First principles:
// - plugins may be built-in today
// - plugins may be subprocesses tomorrow
// - core should trust the same response contract in both cases
//
// So we validate the response as if it crossed a serialized boundary even when
// it came from in-process code.
const schemaPath = path.resolve(import.meta.dirname, '../../../schemas/plugin-response.schema.json');
const schema = readJsonObjectFile(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile<PluginResponse>(schema);

// Small structured error for plugin-output trust-boundary failures.
//
// The message answers the broad class of problem.
// The details answer the more useful follow-up question:
//
//   "which field or rule actually failed?"
export class PluginResponseValidationError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

/**
 * Validate one plugin response before core merges it back into the shared
 * release document.
 *
 * Visual model:
 *
 *   unknown plugin output
 *           ↓
 *     schema validation
 *           ↓
 *   JSON-safety validation
 *           ↓
 *      size-limit check
 *           ↓
 *   trusted response object
 *
 * Why be this strict?
 * Because the release document is our shared source of truth. We do not want
 * JavaScript-only values such as NaN, functions, or circular references to
 * leak into that contract and fail later in more confusing ways.
 */
export function validatePluginResponse(candidate: unknown): ValidatedPluginResponse {
  if (!validate(candidate)) {
    const details = (validate.errors ?? []).map((error: { instancePath?: string; message?: string }) => `${error.instancePath || '/'} ${error.message ?? 'validation error'}`);
    throw new PluginResponseValidationError('invalid plugin response', details);
  }

  // At this point the top-level schema shape is correct.
  // We then do stricter JSON-boundary checks for the two fields that get
  // merged back into shared framework state.
  const response = candidate;
  const releasePatch = readJsonSafeObject('/release_patch', response.release_patch);
  const outputs = readJsonSafeObject('/outputs', response.outputs);
  const details = [
    ...releasePatch.errors,
    ...outputs.errors,
    ...validateSizeBound(response),
  ];

  // Visual model:
  //
  //   top-level schema is fine
  //           ↓
  //   but patch/outputs may still contain JS-only values
  //           ↓
  //   reject before merge-patch reaches shared release state
  if (details.length > 0 || !releasePatch.value || !outputs.value) {
    throw new PluginResponseValidationError('invalid plugin response', details);
  }

  return {
    ...response,
    release_patch: releasePatch.value,
    outputs: outputs.value,
  };
}

// `release_patch` and `outputs` must both be plain JSON objects.
//
// Visual model:
//
//   plugin response field
//          ↓
//   must be an object
//          ↓
//   then every nested value must also be JSON-safe
//
// Why object-only here?
// A plugin response is a structured envelope. Even if a hook wants to say
// "nothing changed", it should return `{}` instead of a primitive or list so
// the contract stays uniform and easier to inspect.
function readJsonSafeObject(pathPrefix: string, value: unknown): { value?: JsonObject; errors: string[] } {
  if (!isJsonObject(value)) {
    return {
      errors: [`${pathPrefix} must be a JSON object`],
    };
  }

  const errors = validateJsonValue(pathPrefix, value, new Set<object>());
  return errors.length > 0
    ? { errors }
    : { value, errors: [] };
}

// A size limit keeps this trust boundary boring on purpose.
//
// Visual model:
//
//   small patch + small outputs
//            ↓
//   easy to inspect
//   easy to log
//   easy to reason about
//
// We want plugin responses to be small patches and small output bags, not huge
// hidden payload channels. Large artifacts belong in explicit files, packages,
// or release assets instead.
function validateSizeBound(response: PluginResponse): string[] {
  try {
    const serialized = JSON.stringify(response);
    return Buffer.byteLength(serialized, 'utf8') <= maxPluginResponseBytes
      ? []
      : [`/ response exceeds max size of ${maxPluginResponseBytes} bytes`];
  } catch {
    return ['/ response must be JSON-serializable'];
  }
}

// Recursively validate JSON-safety instead of relying only on
// `JSON.stringify(...)`.
//
// Why not stringify alone?
// Because stringify can silently coerce or drop some JavaScript values. We want
// early, explicit failures with readable paths such as `/outputs/payload`.
function validateJsonValue(pathPrefix: string, value: unknown, seen: Set<object>): string[] {
  if (value === null) {
    return [];
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return [];
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [`${pathPrefix} must not contain non-finite numbers`];
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return [`${pathPrefix} must not contain circular references`];
    }
    seen.add(value);
    const errors = value.flatMap((entry, index) => validateJsonValue(`${pathPrefix}/${index}`, entry, seen));
    seen.delete(value);
    return errors;
  }
  if (isJsonObject(value)) {
    if (seen.has(value)) {
      return [`${pathPrefix} must not contain circular references`];
    }
    seen.add(value);
    const errors = Object.entries(value).flatMap(([key, entry]) => validateJsonValue(`${pathPrefix}/${escapeJsonPointerSegment(key)}`, entry, seen));
    seen.delete(value);
    return errors;
  }
  return [`${pathPrefix} contains a non-JSON value of type ${typeof value}`];
}

// JSON Pointer paths are only useful if keys with `/` or `~` still point at
// the correct nested field. Escaping keeps error paths unambiguous.
function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
