/**
 * Small shared JSON types.
 *
 * Why this file exists:
 * the framework crosses many serialization boundaries, and repeating raw object
 * map types everywhere makes those boundaries harder to read.
 *
 * Mental model:
 *
 *   JsonPrimitive -> one JSON leaf value
 *   JsonArray     -> a JSON list
 *   JsonObject    -> a JSON object/map
 *   JsonValue     -> any JSON-safe value
 */
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;
export type JsonArray = JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}
