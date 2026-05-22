import type { JsonValue } from './json.js';

/**
 * Shared runtime maps.
 *
 * These are tiny on purpose.
 * They do not add new behavior; they just make boundary intent readable.
 *
 * Examples:
 * - EnvMap      -> process-like environment variables
 * - RuntimeArgs -> CLI/runtime values before they are fully normalized
 * - StringMap   -> simple string-to-string bags such as files or secrets
 * - UnknownMap  -> open-ended maps where the boundary is real but the shape is
 *                  intentionally flexible
 */
export interface EnvMap {
  [key: string]: string | undefined;
}

export interface RuntimeArgs {
  [key: string]: JsonValue | undefined;
}

export interface StringMap {
  [key: string]: string;
}

/**
 * Flexible object map for intentionally open-ended runtime data.
 */
export interface UnknownMap {
  [key: string]: unknown;
}
