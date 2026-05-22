import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PhaseRunner from '../src/core/orchestration/phase-runner.js';

vi.mock('../src/core/orchestration/phase-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PhaseRunner>();
  return {
    ...actual,
    runPluginHook: vi.fn(actual.runPluginHook),
  };
});

import { finalizeRun } from '../src/core/orchestration/finalize-run.js';
import { runPluginHook } from '../src/core/orchestration/phase-runner.js';

const configPath = path.resolve(import.meta.dirname, 'fixtures/artifact-enricher-phases.yml');
const fixedNow = new Date('2026-05-22T19:13:02.000Z');
const sha = '9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c6a5d4e3f2a1b0c';

describe('finalize artifact and enrichment phases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    vi.mocked(runPluginHook).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs artifact publishers/verifiers before metadata enrichers', async () => {
    await finalizeRun({
      configPath,
      providerOverride: 'builtin:generic-env',
      dryRun: true,
      args: {
        repo: 'ExampleOrg/web-app',
        sha,
        branch: 'main',
      },
    });

    const observedHooks = vi.mocked(runPluginHook).mock.calls.map(([context]) => ({
      plugin: context.manifest.name,
      hook: context.hook,
    }));
    const observedDryRunFlags = vi.mocked(runPluginHook).mock.calls.map(([context]) => context.dryRun);

    expect(observedHooks).toEqual([
      { plugin: 'builtin:generic-env', hook: 'normalize' },
      { plugin: 'builtin:deploy-release', hook: 'plan' },
      { plugin: 'builtin:github-release-assets', hook: 'verify' },
      { plugin: 'builtin:npm-registry-verify', hook: 'verify' },
      { plugin: 'builtin:github-release-body-pr-parser', hook: 'enrich' },
    ]);
    expect(observedDryRunFlags).toEqual([true, true, true, true, true]);
  });
});
