import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { errorResponse, okResponse, runPluginCli } from '../src/plugin-sdk/index.js';
import type { PluginRequest } from '../src/core/plugins/request-response.js';

describe('plugin-sdk', () => {
  it('reads PluginRequest JSON from stdin and writes PluginResponse JSON to stdout', async () => {
    const result = await runPluginCliForTest(async (request) => okResponse({}, {
      summary: {
        hook: request.hook,
        dry_run: request.dry_run,
      },
    }, 'handled request'));

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'ok',
      release_patch: {},
      outputs: {
        summary: {
          hook: 'enrich',
          dry_run: true,
        },
      },
      logs: [{ level: 'info', message: 'handled request' }],
    });
  });

  it('returns a structured error response when the handler throws', async () => {
    const result = await runPluginCliForTest(async () => {
      throw new Error('boom');
    });

    expect(result.stderr).toContain('plugin handler failed: boom');
    expect(JSON.parse(result.stdout)).toEqual(errorResponse('plugin handler failed: boom', {
      error_code: 'plugin_handler_failed',
    }));
  });

  it('returns a structured error response when the handler returns a non-object', async () => {
    const result = await runPluginCliForTest(async () => parseTestJson('null'));

    expect(result.stderr).toContain('plugin handler returned a non-object response');
    expect(JSON.parse(result.stdout)).toEqual(errorResponse(
      'plugin handler returned a non-object response; return one PluginResponse JSON object',
      { error_code: 'invalid_plugin_response' },
    ));
  });

  it('returns a structured error response when stdin JSON is not PluginRequest-shaped', async () => {
    const result = await runPluginCliForTest(async () => okResponse({}), '{"unexpected":true}');

    expect(result.stderr).toContain('stdin JSON must be a PluginRequest-shaped object');
    expect(JSON.parse(result.stdout)).toEqual(errorResponse(
      'stdin JSON must be a PluginRequest-shaped object',
      { error_code: 'invalid_plugin_request_shape' },
    ));
  });

  it('omits undefined optional fields from error responses', () => {
    expect(errorResponse('boom')).toEqual({
      status: 'error',
      release_patch: {},
      outputs: {},
      logs: [{ level: 'error', message: 'boom' }],
      error_message: 'boom',
    });
  });
});

async function runPluginCliForTest(
  handler: Parameters<typeof runPluginCli>[0],
  requestJson: string = JSON.stringify(createRequest()),
): Promise<{ stdout: string; stderr: string }> {
  const stdin = new PassThrough();
  let stdout = '';
  let stderr = '';

  const run = runPluginCli(handler, {
    stdin,
    stdout: {
      write(chunk: string) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
      },
    },
  });

  stdin.end(requestJson);
  await run;

  return { stdout, stderr };
}

function parseTestJson(value: string): unknown {
  return JSON.parse(value);
}

function createRequest(): PluginRequest {
  return {
    plugin_api_version: 1,
    hook: 'enrich',
    dry_run: true,
    plugin: {
      name: 'example-plugin',
      version: '1.0.0',
    },
    config: {},
    release: null,
    inputs: {
      env: {},
      args: {},
      files: {},
    },
    secrets: {},
    workspace: {
      root: '/tmp/example-workspace',
    },
  };
}
