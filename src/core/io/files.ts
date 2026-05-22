import fs from 'node:fs';
import path from 'node:path';

import type { JsonObject } from '../types/json.js';

/**
 * Read and parse a JSON file as unknown external input.
 *
 * Callers should validate or narrow the result before trusting its shape.
 */
export function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

/**
 * Read and require a JSON object at the top level.
 *
 * This is useful for config patches, schemas, and other files where the caller
 * expects an object map rather than an array or primitive.
 */
export function readJsonObjectFile(filePath: string): JsonObject {
  const parsed = readJsonFile(filePath);
  if (!isJsonObject(parsed)) {
    throw new Error(`expected JSON object in ${filePath}`);
  }
  return parsed;
}

export function writeJsonFile(filePath: string, data: unknown): void {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
