// Tests for `validate-plugin`, the author-facing plugin validation command.
//
// This command serves two audiences:
// - humans reading the default terminal output (tested via stdout spy)
// - tools/scripts reading --json output (tested via JSON parse)
//
// The tests verify the most important author-loop behaviors:
// 1. Human-readable success summaries show plugin info + check results
// 2. Machine-readable JSON output includes structured steps
// 3. Plugin config validation errors are surfaced with schema paths
// 4. Undeclared hook requests are rejected with the declared hooks list
// 5. Request fixtures load cleanly and can drive hook selection
// 6. Explicit hook/fixture mismatches are rejected clearly
// 7. Mutually incompatible flags (--plugin-config-json + --request-json) are rejected
// 8. Provider plugins still validate against release-config-shaped request.config
// 9. Multi-hook plugins surface sample fixture suggestions
//
// All tests use the checked-in example plugin to keep the test surface
// realistic and the assertions easy to reason about.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runValidatePluginCommand } from '../src/cli/commands/validate-plugin.js';

const examplePluginRef = 'path:./examples/plugins/example-enricher';
const notifierPluginRef = 'path:./examples/plugins/example-notifier';
const providerPluginRef = 'builtin:generic-env';
const enrichRequestFixturePath = 'examples/plugins/requests/enrich.request.json';
const normalizeRequestFixturePath = 'examples/plugins/requests/normalize.request.json';
const renderRequestFixturePath = 'examples/plugins/requests/render.request.json';
const notifyRequestFixturePath = 'examples/plugins/requests/notify.request.json';
const requestFixtureDirectoryPath = 'examples/plugins/requests';
const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
const tempPaths: string[] = [];

describe('validate-plugin command', () => {
  afterEach(() => {
    writeSpy.mockClear();
    while (tempPaths.length > 0) {
      const tempPath = tempPaths.pop();
      if (tempPath) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    }
  });

  it('prints a human-readable success summary', async () => {
    await runValidatePluginCommand({
      plugin: examplePluginRef,
      hook: 'enrich',
    });

    const output = readLastStdoutWrite();
    expect(output).toContain('Plugin: path:./examples/plugins/example-enricher');
    expect(output).toContain('Execution checks:');
    expect(output).toContain('dry-run hook executed');
    expect(output).toContain('hook=enrich');
  });

  it('prints machine-readable JSON output', async () => {
    await runValidatePluginCommand({
      plugin: examplePluginRef,
      json: true,
      no_exec: true,
    });

    const parsed = readValidatePluginJson(readLastStdoutWrite());

    expect(parsed.status).toBe('ok');
    expect(parsed.plugin.name).toBe('example-enricher');
    expect(parsed.steps.some((step) => step.name === 'plugin-config-validated')).toBe(true);
  });

  it('prints stable machine-readable JSON for multiple explicit fixtures', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      json: true,
      request_json: [notifyRequestFixturePath, renderRequestFixturePath],
    });

    const parsed = readValidatePluginJson(readLastStdoutWrite());
    expect(parsed.steps.filter((step) => step.name === 'request-fixture-loaded')).toHaveLength(2);
    expect(parsed.hook_results.map((hookResult) => hookResult.hook)).toEqual(['notify', 'render']);
  });

  it('prints stable machine-readable JSON for fixture directory mode', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      json: true,
      request_json_dir: requestFixtureDirectoryPath,
    });

    const parsed = readValidatePluginJson(readLastStdoutWrite());
    expect(parsed.steps.filter((step) => step.name === 'request-fixture-loaded')).toHaveLength(2);
    expect(parsed.hook_results.map((hookResult) => hookResult.hook)).toEqual(['render', 'notify']);
  });

  it('surfaces plugin config validation errors clearly', async () => {
    const invalidConfigPath = writeTempJsonFile({
      summary_label: 42,
    });

    await expect(runValidatePluginCommand({
      plugin: examplePluginRef,
      plugin_config_json: invalidConfigPath,
    })).rejects.toMatchObject({
      message: 'plugin path:./examples/plugins/example-enricher failed plugin-config validation',
      details: expect.arrayContaining([
        `config_source=${invalidConfigPath}`,
        expect.stringContaining('/summary_label must be string'),
      ]),
    });
  });

  it('surfaces undeclared hook requests clearly', async () => {
    await expect(runValidatePluginCommand({
      plugin: examplePluginRef,
      hook: 'notify',
    })).rejects.toThrowError('requested hook notify is not declared by the plugin');
  });

  it('can validate against a richer request fixture JSON object', async () => {
    await runValidatePluginCommand({
      plugin: examplePluginRef,
      request_json: [enrichRequestFixturePath],
    });

    const output = readLastStdoutWrite();
    expect(output).toContain('request fixture loaded');
    expect(output).toContain(`request_source=${path.resolve(enrichRequestFixturePath)}`);
  });

  // Request fixtures now answer two questions at once:
  //
  //   which runtime shape should we validate?
  //   which hook is that shape meant for?
  //
  // This test protects the second rule. A render-shaped fixture should drive
  // render validation by default instead of accidentally validating notify too.
  it('defaults hook selection from the request fixture when --hook is omitted', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json: [renderRequestFixturePath],
    });

    const output = readLastStdoutWrite();
    expect(output).toContain('hook=render');
    expect(output).not.toContain('hook=notify');
  });

  it('rejects explicit hook selections that disagree with the request fixture hook', async () => {
    await expect(runValidatePluginCommand({
      plugin: notifierPluginRef,
      hook: 'notify',
      request_json: [renderRequestFixturePath],
    })).rejects.toMatchObject({
      message: 'requested hook notify does not match request fixture hook render',
      details: expect.arrayContaining([
        `request_source=${path.resolve(renderRequestFixturePath)}`,
      ]),
    });
  });

  it('prioritizes undeclared-hook errors over fixture-mismatch errors', async () => {
    await expect(runValidatePluginCommand({
      plugin: examplePluginRef,
      hook: 'notify',
      request_json: [enrichRequestFixturePath],
    })).rejects.toMatchObject({
      message: 'requested hook notify is not declared by the plugin',
      details: expect.arrayContaining([
        'declared_hooks=enrich',
      ]),
    });
  });

  it('can validate one multi-hook plugin against multiple request fixtures in one run', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json: [renderRequestFixturePath, notifyRequestFixturePath],
    });

    const output = readLastStdoutWrite();
    expect(output).toContain(`request_source=${path.resolve(renderRequestFixturePath)}`);
    expect(output).toContain(`request_source=${path.resolve(notifyRequestFixturePath)}`);
    expect(output).toContain('hook=render; response_status=ok');
    expect(output).toContain('hook=notify; response_status=noop');
  });

  it('rejects repeated request fixtures for the same hook clearly', async () => {
    await expect(runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json: [renderRequestFixturePath, renderRequestFixturePath],
    })).rejects.toMatchObject({
      message: 'request fixtures must not repeat hook render',
    });
  });

  it('rejects --hook when multiple request fixtures are provided', async () => {
    await expect(runValidatePluginCommand({
      plugin: notifierPluginRef,
      hook: 'render',
      request_json: [renderRequestFixturePath, notifyRequestFixturePath],
    })).rejects.toMatchObject({
      message: 'cannot use --hook together with multiple request fixtures',
    });
  });

  it('can auto-match request fixtures from a directory for a multi-hook plugin', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json_dir: requestFixtureDirectoryPath,
    });

    const output = readLastStdoutWrite();
    expect(output).toContain(`request_source=${path.resolve(renderRequestFixturePath)}`);
    expect(output).toContain(`request_source=${path.resolve(notifyRequestFixturePath)}`);
    expect(output).toContain('hook=render; response_status=ok');
    expect(output).toContain('hook=notify; response_status=noop');
  });

  it('allows partial directory matches and ignores unrelated files', async () => {
    const fixtureDirectory = createFixtureDirectory({
      'render.request.json': readFixtureFile(renderRequestFixturePath),
      'ignored.json': '{"not":"a fixture"}\n',
    });

    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json_dir: fixtureDirectory,
    });

    const output = readLastStdoutWrite();
    expect(output).toContain(`request_source=${path.resolve(path.join(fixtureDirectory, 'render.request.json'))}`);
    expect(output).not.toContain('notify.request.json');
    expect(output).toContain('hook=render; response_status=ok');
  });

  it('can auto-match one hook from a fixture directory when --hook is provided', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      hook: 'render',
      request_json_dir: requestFixtureDirectoryPath,
    });

    const output = readLastStdoutWrite();
    expect(output).toContain(`request_source=${path.resolve(renderRequestFixturePath)}`);
    expect(output).not.toContain(`request_source=${path.resolve(notifyRequestFixturePath)}`);
    expect(output).toContain('hook=render; response_status=ok');
  });

  it('preserves explicit request fixture order in human output', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json: [notifyRequestFixturePath, renderRequestFixturePath],
    });

    const output = readLastStdoutWrite();
    const notifyPosition = output.indexOf(`request_source=${path.resolve(notifyRequestFixturePath)}`);
    const renderPosition = output.indexOf(`request_source=${path.resolve(renderRequestFixturePath)}`);
    expect(notifyPosition).toBeGreaterThanOrEqual(0);
    expect(renderPosition).toBeGreaterThan(notifyPosition);
  });

  it('preserves declared hook order in directory mode', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json_dir: requestFixtureDirectoryPath,
    });

    const output = readLastStdoutWrite();
    const renderPosition = output.indexOf(`request_source=${path.resolve(renderRequestFixturePath)}`);
    const notifyPosition = output.indexOf(`request_source=${path.resolve(notifyRequestFixturePath)}`);
    expect(renderPosition).toBeGreaterThanOrEqual(0);
    expect(notifyPosition).toBeGreaterThan(renderPosition);
  });

  it('rejects conflicting request/config override flags clearly', async () => {
    const validConfigPath = writeTempJsonFile({
      summary_label: 'Example enricher summary',
    });

    await expect(runValidatePluginCommand({
      plugin: examplePluginRef,
      plugin_config_json: validConfigPath,
      request_json: [enrichRequestFixturePath],
    })).rejects.toMatchObject({
      message: 'cannot use --plugin-config-json together with request fixtures',
    });
  });

  it('rejects mixing explicit request fixtures with a fixture directory', async () => {
    await expect(runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json: [renderRequestFixturePath],
      request_json_dir: requestFixtureDirectoryPath,
    })).rejects.toMatchObject({
      message: 'cannot use --request-json together with --request-json-dir',
    });
  });

  it('fails clearly when no fixture files match in a directory', async () => {
    await expect(runValidatePluginCommand({
      plugin: notifierPluginRef,
      request_json_dir: 'examples/plugins/example-notifier',
    })).rejects.toMatchObject({
      message: `no request fixtures matched in directory ${path.resolve('examples/plugins/example-notifier')}`,
    });
  });

  it('surfaces undeclared hook requests clearly in directory mode', async () => {
    await expect(runValidatePluginCommand({
      plugin: examplePluginRef,
      hook: 'notify',
      request_json_dir: requestFixtureDirectoryPath,
    })).rejects.toMatchObject({
      message: 'requested hook notify is not declared by the plugin',
      details: expect.arrayContaining([
        'declared_hooks=enrich',
      ]),
    });
  });

  it('can validate a provider plugin with its sample release-config shape', async () => {
    await runValidatePluginCommand({
      plugin: providerPluginRef,
      hook: 'normalize',
    });

    const output = readLastStdoutWrite();
    expect(output).toContain('Plugin: builtin:generic-env');
    expect(output).toContain('config_kind=release-config');
    expect(output).toContain('config_source=built-in sample release config');
  });

  it('can validate a provider plugin from an explicit normalize fixture', async () => {
    await runValidatePluginCommand({
      plugin: providerPluginRef,
      request_json: [normalizeRequestFixturePath],
    });

    const output = readLastStdoutWrite();
    expect(output).toContain(`request_source=${path.resolve(normalizeRequestFixturePath)}`);
    expect(output).toContain('hook=normalize; response_status=ok');
  });

  it('can validate a provider plugin from fixture directory mode', async () => {
    await runValidatePluginCommand({
      plugin: providerPluginRef,
      request_json_dir: requestFixtureDirectoryPath,
    });

    const output = readLastStdoutWrite();
    expect(output).toContain(`request_source=${path.resolve(normalizeRequestFixturePath)}`);
    expect(output).toContain('hook=normalize; response_status=ok');
  });

  it('can validate a provider plugin from fixture directory mode with --hook normalize', async () => {
    await runValidatePluginCommand({
      plugin: providerPluginRef,
      hook: 'normalize',
      request_json_dir: requestFixtureDirectoryPath,
    });

    const output = readLastStdoutWrite();
    expect(output).toContain(`request_source=${path.resolve(normalizeRequestFixturePath)}`);
    expect(output).toContain('hook=normalize; response_status=ok');
  });

  // Multi-hook plugins are where authors most often ask
  // "which fixture should I try first?"
  //
  // The command now answers that question directly in human output instead of
  // forcing the author to inspect source or docs before their first run.
  it('surfaces sample fixture suggestions for multi-hook plugins without request fixtures', async () => {
    await runValidatePluginCommand({
      plugin: notifierPluginRef,
      no_exec: true,
    });

    const output = readLastStdoutWrite();
    expect(output).toContain('sample request fixtures available');
    expect(output).toContain('render=examples/plugins/requests/render.request.json');
    expect(output).toContain('notify=examples/plugins/requests/notify.request.json');
  });
});

// Read the last write to stdout from our mock spy.
//
// The validate-plugin command writes its output via process.stdout.write, so
// we spy on stdout instead of capturing console output.
function readLastStdoutWrite(): string {
  const lastCall = writeSpy.mock.calls.at(-1);
  if (!lastCall) {
    throw new Error('expected process.stdout.write to be called');
  }
  const [value] = lastCall;
  return String(value);
}

// Write a JSON value to a temp file, register it for cleanup, and return the
// absolute path. Used to create one-shot plugin config JSON files for tests.
function writeTempJsonFile(data: unknown): string {
  const tempFile = path.join(os.tmpdir(), `validate-plugin-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  tempPaths.push(tempFile);
  return tempFile;
}

// Parse and type-narrow a validate-plugin JSON output string.
//
// The type guard checks for the minimum structural shape (status, plugin.name,
// steps) without asserting on every field so tests can add new fields without
// breaking the type check.
function readValidatePluginJson(value: string): {
  status: string;
  plugin: { name: string };
  steps: Array<{ name: string }>;
  hook_results: Array<{ hook: string }>;
} {
  const parsed: unknown = JSON.parse(value);
  if (!isValidatePluginJson(parsed)) {
    throw new Error('expected validate-plugin JSON output');
  }
  return parsed;
}

function isValidatePluginJson(value: unknown): value is {
  status: string;
  plugin: { name: string };
  steps: Array<{ name: string }>;
  hook_results: Array<{ hook: string }>;
} {
  return typeof value === 'object'
    && value !== null
    && 'status' in value
    && typeof value.status === 'string'
    && 'plugin' in value
    && typeof value.plugin === 'object'
    && value.plugin !== null
    && 'name' in value.plugin
    && typeof value.plugin.name === 'string'
    && 'steps' in value
    && Array.isArray(value.steps)
    && value.steps.every((step) => typeof step === 'object' && step !== null && 'name' in step && typeof step.name === 'string')
    && 'hook_results' in value
    && Array.isArray(value.hook_results)
    && value.hook_results.every((hookResult) => typeof hookResult === 'object' && hookResult !== null && 'hook' in hookResult && typeof hookResult.hook === 'string');
}

function createFixtureDirectory(files: Record<string, string>): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-plugin-fixtures-'));
  tempPaths.push(tempDir);
  for (const [relativePath, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tempDir, relativePath), content, 'utf8');
  }
  return tempDir;
}

function readFixtureFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}
