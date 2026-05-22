import type { JsonObject } from '../types/json.js';

/**
 * Apply RFC 7386-style merge patch behavior.
 *
 * Why this helper exists:
 * plugins should patch only the fields they own instead of replacing the whole
 * release document. That keeps plugin responsibilities small and composable.
 */
export function applyMergePatch<T>(target: T, patch: unknown): T {
  if (!isObject(patch)) {
    return patch as T;
  }

  const base: JsonObject = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    if (isObject(value) && isObject(base[key])) {
      base[key] = applyMergePatch(base[key], value);
      continue;
    }
    base[key] = value;
  }
  return base as T;
}

/**
 * Treat only plain non-array objects as mergeable maps.
 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
