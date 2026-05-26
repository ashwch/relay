import * as core from '@actions/core';

import { defaultConfigPath } from '../core/constants.js';

/**
 * Thin GitHub Action entrypoint.
 *
 * Why keep this file thin?
 * We want the CLI, the reusable workflow, and the direct action path to share
 * one core implementation. That makes behavior easier to reason about and keeps
 * GitHub-specific glue from becoming a second codepath.
 */

import { finalizeRun } from '../core/orchestration/finalize-run.js';
import { writeJsonFile } from '../core/io/files.js';

/**
 * Read GitHub Action inputs, call the shared finalize flow, then expose the
 * machine-readable result as action outputs.
 */
async function run(): Promise<void> {
  try {
    await runAction();
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

async function runAction(): Promise<void> {
  const outputJson = readOptionalInput('output_json') ?? '.relay/result.json';
  const result = await finalizeRun({
    configPath: readOptionalInput('config_path') ?? defaultConfigPath,
    providerOverride: readOptionalInput('provider_plugin'),
    profileOverride: readOptionalInput('release_profile'),
    metadataPath: readOptionalInput('metadata_path'),
    dryRun: core.getBooleanInput('dry_run'),
    args: {
      release_ref: readOptionalInput('release_ref'),
      force_notify: core.getBooleanInput('force_notify'),
    },
  });

  writeJsonFile(outputJson, result);
  core.setOutput('release_tag', result.release_tag);
  core.setOutput('release_url', result.release_url ?? '');
  core.setOutput('release_mode', result.release_mode);
  core.setOutput('profile', result.profile);
  core.setOutput('notification_sent', result.notification_sent ? 'true' : 'false');
  core.setOutput('result_json', JSON.stringify(result));
}

/**
 * GitHub Actions exposes unset inputs as empty strings.
 * Converting them to undefined makes downstream option handling cleaner.
 */
function readOptionalInput(name: string): string | undefined {
  const value = core.getInput(name);
  return value.length > 0 ? value : undefined;
}

void run();
