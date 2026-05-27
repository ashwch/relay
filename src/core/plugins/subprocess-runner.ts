import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { defaultPluginHookTimeoutMs, maxPluginResponseBytes, maxPluginStderrBytes } from '../constants.js';
import type { PluginManifest } from './manifest.js';
import type { PluginRequest } from './request-response.js';

// External plugins get only a tiny process environment.
//
// Why not pass through everything from CI?
// Because this process env is *not* meant to be the plugin contract.
// The real contract is the PluginRequest JSON sent over stdin plus the
// explicitly resolved `request.secrets` map.
//
// The small inherited env below only keeps the subprocess runnable on common
// developer machines and CI containers.
const minimalExternalEnvKeys = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
] as const;

// Error for subprocess-boundary failures.
//
// Examples:
// - process failed to start
// - hook timed out
// - stdout was too large
// - stdout was not valid JSON
//
// We keep this separate from response-validation errors because
// "the process boundary failed" and
// "the plugin returned the wrong contract" are different problems.
export class ExternalPluginExecutionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Execute one external plugin hook in a subprocess.
 *
 * Visual model:
 *
 *   core request object
 *         ↓ JSON over stdin
 *   external plugin process
 *         ↓ JSON over stdout
 *   core validates response
 *
 * Why a subprocess boundary?
 * Because external plugin code should not run inside the framework process.
 * This keeps the trust boundary explicit and makes future non-JavaScript
 * plugins possible as long as they honor the same stdin/stdout contract.
 */
export async function runExternalPluginHook(
  manifest: PluginManifest,
  pluginRoot: string,
  request: PluginRequest,
  timeoutMs: number = defaultPluginHookTimeoutMs,
): Promise<unknown> {
  const entrypoint = resolveEntrypoint(pluginRoot, manifest);

  // The subprocess sees one small, explicit contract:
  // - stdin  -> PluginRequest JSON
  // - stdout -> PluginResponse JSON
  // - stderr -> debug/error context only
  //
  // That shape is intentionally simple so future plugin authors do not need to
  // understand internal framework modules to participate.
  const child = spawn(entrypoint.command, entrypoint.args, {
    cwd: pluginRoot,
    env: buildExternalPluginEnv(),
    stdio: 'pipe',
  });

  return await new Promise<unknown>((resolve, reject) => {
    // One hook execution should end in exactly one outcome:
    //
    //   resolved JSON value
    //   or one clear execution error
    //
    // The `finish(...)` helper below keeps timeout, close, and startup-error
    // paths from racing each other and producing duplicate resolution.
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new ExternalPluginExecutionError(`external plugin ${manifest.name} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    let finished = false;

    const finish = (callback: () => void) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // stdout is the machine-readable response channel.
      // Keep it bounded so plugin authors do not accidentally turn it into a
      // bulk data transport path.
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > maxPluginResponseBytes) {
        child.kill('SIGKILL');
        finish(() => reject(new ExternalPluginExecutionError(`external plugin ${manifest.name} exceeded stdout limit of ${maxPluginResponseBytes} bytes`)));
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // stderr is only for debug/error context.
      // We keep a truncated copy so failure messages stay helpful without
      // letting noisy plugins flood the parent process.
      stderr = appendTruncatedUtf8(stderr, chunk, maxPluginStderrBytes);
    });

    child.on('error', (error) => {
      finish(() => reject(new ExternalPluginExecutionError(`external plugin ${manifest.name} failed to start: ${error.message}`)));
    });

    child.on('close', (code, signal) => {
      finish(() => {
        // Close handling is intentionally ordered from
        // "process-level failure"
        // down to
        // "stdout parse failure"
        // so the author sees the most fundamental problem first.
        if (signal) {
          reject(new ExternalPluginExecutionError(`external plugin ${manifest.name} exited via signal ${signal}${formatStderr(stderr)}`));
          return;
        }
        if (code !== 0) {
          reject(new ExternalPluginExecutionError(`external plugin ${manifest.name} exited with code ${code}${formatStderr(stderr)}`));
          return;
        }
        if (stdout.trim().length === 0) {
          reject(new ExternalPluginExecutionError(`external plugin ${manifest.name} returned no stdout JSON${formatStderr(stderr)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new ExternalPluginExecutionError(`external plugin ${manifest.name} returned invalid JSON: ${message}${formatStderr(stderr)}`));
        }
      });
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE-like write errors here.
      // The close/error handlers above will surface the real process failure.
    });
    child.stdin.end(JSON.stringify(request));
  });
}

interface EntrypointCommand {
  // `command + args` keeps module-style and executable-style plugins on the
  // same runtime path while still making the launched process easy to inspect.
  command: string;
  args: string[];
}

// Resolve the actual subprocess command from the manifest entrypoint.
//
// Today we support two external styles:
//
//   kind=module -> node <handler>
//   kind=path   -> <handler> directly
//
// Visual model:
//
//   manifest entrypoint
//          ↓
//   concrete command + args
//          ↓
//   one subprocess launch plan
//
// This keeps the author contract small while still allowing self-contained
// executable plugins later.
function resolveEntrypoint(pluginRoot: string, manifest: PluginManifest): EntrypointCommand {
  const resolvedHandler = path.resolve(pluginRoot, manifest.entrypoint.handler);
  assertContainedPath(pluginRoot, resolvedHandler, manifest);

  return manifest.entrypoint.kind === 'module'
    ? {
      command: process.execPath,
      args: [resolvedHandler],
    }
    : {
      command: resolvedHandler,
      args: [],
    };
}

// The manifest may point at a handler inside the plugin root, but not outside
// it. That prevents a plugin from "escaping" its own allowlisted directory and
// silently executing unrelated files from the workspace.
function assertContainedPath(pluginRoot: string, candidatePath: string, manifest: PluginManifest): void {
  const relativePath = path.relative(pluginRoot, candidatePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new ExternalPluginExecutionError(`plugin ${manifest.name} handler must stay inside plugin root`);
  }

  // Lexical containment alone is not enough here.
  // A handler path that looks like it lives inside the plugin root can still be
  // a symlink whose real target escapes the allowlisted directory.
  if (fs.existsSync(candidatePath)) {
    const realPluginRoot = fs.realpathSync(pluginRoot);
    const realCandidatePath = fs.realpathSync(candidatePath);
    const realRelativePath = path.relative(realPluginRoot, realCandidatePath);
    if (realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
      throw new ExternalPluginExecutionError(`plugin ${manifest.name} handler must stay inside plugin root`);
    }
  }
}

// Build the tiny inherited process env for external subprocesses.
//
// Important distinction:
// - process env here is just enough to launch the subprocess
// - request.inputs.env is the plugin-visible runtime input bag
// - request.secrets is the explicit secret channel
//
// Visual model:
//
//   host process env
//          ↓ select a tiny safe subset
//   subprocess launch env
//
// Why keep this tiny?
// Because external plugin behavior should depend on explicit request fields,
// not on ambient CI environment leaks.
function buildExternalPluginEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of minimalExternalEnvKeys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

// Attach stderr only when it adds real debugging value.
// Empty stderr should not make errors noisier.
function formatStderr(stderr: string): string {
  return stderr.trim().length > 0 ? `; stderr: ${stderr.trim()}` : '';
}

// Truncate by bytes, not by JavaScript string length.
//
// stderr limits are operational limits, so they should behave predictably even
// when a plugin emits multi-byte UTF-8 characters.
function appendTruncatedUtf8(existing: string, chunk: string, limitBytes: number): string {
  const existingBytes = Buffer.byteLength(existing, 'utf8');
  if (existingBytes >= limitBytes) {
    return existing;
  }

  const remainingBytes = limitBytes - existingBytes;
  const truncatedChunk = Buffer.from(chunk, 'utf8').subarray(0, remainingBytes).toString('utf8');
  return `${existing}${truncatedChunk}`;
}
