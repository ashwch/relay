import process from 'node:process';

/**
 * Stable JavaScript/TypeScript author SDK for external plugins.
 *
 * Why this file exists:
 * plugin authors should not have to rewrite the same stdin parsing,
 * stdout serialization, and basic error-shaping boilerplate in every plugin.
 *
 * How plugin authors import it:
 *
 *   import { okResponse, runPluginCli } from "@ashwch/relay/plugin-sdk";
 *
 * The package.json exports map (@ashwch/relay → ./plugin-sdk → dist/plugin-sdk/)
 * keeps the import path short and stable. Plugin authors do not need to know
 * about internal monorepo layout.
 *
 * Visual model:
 *
 *   framework
 *      ↓ writes PluginRequest JSON to stdin
 *   runPluginCli(...)
 *      ↓ validates basic request shape
 *   your handler(request)
 *      ↓ returns PluginResponse object
 *   runPluginCli(...)
 *      ↓ writes JSON to stdout
 *   framework validates response contract
 *
 * Important design rule:
 * this SDK does not replace the JSON contract.
 * It only makes that contract easier to honor consistently.
 */

import type { JsonObject, JsonValue } from '../core/types/json.js';
import type { StringMap, UnknownMap } from '../core/types/runtime.js';
import type { HookName, PluginRequest, PluginResponse } from '../core/plugins/request-response.js';

export type { HookName, PluginRequest, PluginResponse };
export type { JsonObject, JsonValue };

// The one thing a plugin author usually wants to write:
//
//   async (request) => PluginResponse
//
// We keep the type small and direct so the plugin boundary stays obvious.
export type PluginRequestHandler = (request: PluginRequest) => PluginResponse | Promise<PluginResponse>;

// These overrides mostly exist for tests and future embedding.
// Real plugin authors normally call runPluginCli(handler) with no options.
export interface RunPluginCliOptions {
  stdin?: ReadableTextStream;
  stdout?: WritableTextStream;
  stderr?: WritableTextStream;
}

interface ReadableTextStream {
  setEncoding(encoding: BufferEncoding): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

interface WritableTextStream {
  write(chunk: string): void | boolean;
}

// Small stable helper for the common success case.
//
// Why keep the signature JSON-shaped?
// Because the plugin boundary is JSON over stdin/stdout, so the helper should
// encourage authors to return JSON-safe objects directly.
export function okResponse(release_patch: JsonObject = {}, outputs: JsonObject = {}, message?: string): PluginResponse {
  return {
    status: 'ok',
    release_patch,
    outputs,
    logs: message ? [{ level: 'info', message }] : [],
  };
}

// Helper for "this hook intentionally did nothing".
//
// Common example:
// a notify hook in dry-run mode that wants to report what *would* have
// happened without performing the side effect.
export function noopResponse(outputs: JsonObject = {}, message?: string): PluginResponse {
  return {
    status: 'noop',
    release_patch: {},
    outputs,
    logs: message ? [{ level: 'info', message }] : [],
  };
}

// Helper for explicit plugin-level failure.
//
// Why keep this structured?
// Because downstream framework code treats `status: "error"` as a real hook
// failure, and authors should be able to attach a human-readable message and a
// small machine-readable error_code without hand-building the envelope.
export function errorResponse(
  error_message: string,
  options: {
    release_patch?: JsonObject;
    outputs?: JsonObject;
    error_code?: string;
    log_message?: string;
  } = {},
): PluginResponse {
  return {
    status: 'error',
    release_patch: options.release_patch ?? {},
    outputs: options.outputs ?? {},
    logs: [{ level: 'error', message: options.log_message ?? error_message }],
    ...(options.error_code ? { error_code: options.error_code } : {}),
    error_message,
  };
}

// Run one external plugin handler against the stdin/stdout JSON contract.
//
// Visual model:
//
//   PluginRequest JSON on stdin
//          ↓
//      handler(request)
//          ↓
//   PluginResponse JSON on stdout
//
// The helper intentionally keeps stdout machine-readable even on handler
// errors by returning a structured error response instead of throwing past the
// process boundary.
export async function runPluginCli(handler: PluginRequestHandler, options: RunPluginCliOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const input = await readStdinUtf8(stdin);
    let request: PluginRequest;
    try {
      const parsed: unknown = JSON.parse(input);

      // Why do a light shape check here if core also validates requests on its
      // side?
      //
      // Because plugin authors deserve a local error that says
      // "stdin did not look like a PluginRequest"
      // instead of getting a vague crash deeper inside their handler.
      if (!isPluginRequestEnvelope(parsed)) {
        const message = 'stdin JSON must be a PluginRequest-shaped object';
        stderr.write(`[relay/plugin-sdk] ${message}\n`);
        writeResponse(stdout, errorResponse(message, { error_code: 'invalid_plugin_request_shape' }));
        return;
      }
      request = parsed;
    } catch (error) {
      const message = `failed to parse PluginRequest JSON from stdin: ${formatErrorMessage(error)}`;
      stderr.write(`[relay/plugin-sdk] ${message}\n`);
      writeResponse(stdout, errorResponse(message, { error_code: 'invalid_plugin_request_json' }));
      return;
    }

    const response = await handler(request);
    if (!isPluginResponseObject(response)) {
      const message = 'plugin handler returned a non-object response; return one PluginResponse JSON object';
      stderr.write(`[relay/plugin-sdk] ${message}\n`);
      writeResponse(stdout, errorResponse(message, { error_code: 'invalid_plugin_response' }));
      return;
    }
    writeResponse(stdout, response);
  } catch (error) {
    const message = `plugin handler failed: ${formatErrorMessage(error)}`;
    stderr.write(`[relay/plugin-sdk] ${message}\n`);
    writeResponse(stdout, errorResponse(message, { error_code: 'plugin_handler_failed' }));
  }
}

// Keep stdout machine-readable.
//
// Important rule:
// stdout is part of the plugin/runtime contract.
// If serialization fails, we want one small explicit error instead of silently
// writing `undefined` or partial output.
function writeResponse(stdout: WritableTextStream, response: PluginResponse): void {
  const serialized = JSON.stringify(response);
  if (serialized === undefined) {
    throw new Error('plugin response is not JSON-serializable');
  }
  stdout.write(`${serialized}\n`);
}

// Read the full request body before parsing.
//
// The framework writes exactly one JSON request per hook execution, so reading
// stdin to completion keeps the author mental model simple:
//
//   one request in
//   one response out
async function readStdinUtf8(stdin: ReadableTextStream): Promise<string> {
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let input = '';
    stdin.on('data', (chunk) => {
      input += chunk;
    });
    stdin.on('end', () => {
      resolve(input);
    });
    stdin.on('error', (error) => {
      reject(error);
    });
  });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPluginResponseObject(value: unknown): value is PluginResponse {
  return typeof value === 'object' && value !== null;
}

// This is intentionally a light boundary guard, not a full schema validator.
//
// Why keep it light?
// - core already owns the authoritative request contract
// - plugin authors mainly need protection against obviously wrong local input
// - keeping this guard small makes the SDK easier to audit and maintain
function isPluginRequestEnvelope(value: unknown): value is PluginRequest {
  if (!isObject(value)) {
    return false;
  }

  return value.plugin_api_version === 1
    && isHookName(value.hook)
    && typeof value.dry_run === 'boolean'
    && isPluginMetadata(value.plugin)
    && 'config' in value
    && (value.release === null || isObject(value.release))
    && isPluginInputs(value.inputs)
    && isStringRecord(value.secrets)
    && isWorkspace(value.workspace);
}

function isPluginMetadata(value: unknown): value is PluginRequest['plugin'] {
  return isObject(value)
    && typeof value.name === 'string'
    && typeof value.version === 'string';
}

// The SDK only checks the broad structural shape here.
// `args` stays intentionally flexible because the framework allows JSON-safe
// values there, not just strings.
function isPluginInputs(value: unknown): value is PluginRequest['inputs'] {
  return isObject(value)
    && isStringRecord(value.env)
    && isObject(value.args)
    && isStringRecord(value.files);
}

function isWorkspace(value: unknown): value is PluginRequest['workspace'] {
  return isObject(value)
    && typeof value.root === 'string';
}

function isStringRecord(value: unknown): value is StringMap {
  return isObject(value)
    && Object.values(value).every((entryValue) => typeof entryValue === 'string');
}

function isObject(value: unknown): value is UnknownMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookName(value: unknown): value is HookName {
  return value === 'normalize'
    || value === 'plan'
    || value === 'observe'
    || value === 'publish'
    || value === 'verify'
    || value === 'enrich'
    || value === 'render'
    || value === 'notify';
}
