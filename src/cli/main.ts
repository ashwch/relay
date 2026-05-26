#!/usr/bin/env node
import { Command } from 'commander';

import { runFinalizeCommand, type FinalizeCommandOptions } from './commands/finalize.js';
import { runInspectConfigCommand } from './commands/inspect-config.js';
import { runListPluginsCommand } from './commands/list-plugins.js';
import { runNormalizeCommand, type NormalizeCommandOptions } from './commands/normalize.js';
import { runRenderNotificationCommand } from './commands/render-notification.js';
import { runValidatePluginCommand, ValidatePluginCommandError } from './commands/validate-plugin.js';
import { defaultConfigPath } from '../core/constants.js';
import { ConfigValidationError } from '../core/config/validate-config.js';
import { PluginAllowlistError } from '../core/plugins/allowlist.js';
import { PluginManifestError } from '../core/plugins/manifest.js';
import { PluginLoadError } from '../core/plugins/loader.js';
import { PluginConfigValidationError } from '../core/plugins/config-validation.js';
import { PluginResponseValidationError } from '../core/plugins/response-validation.js';
import { ReleaseInvariantError } from '../core/release-json/invariants.js';

interface CommonCommanderOptions {
  config: string;
  provider?: string;
  releaseProfile?: string;
  metadataPath?: string;
  outputJson?: string;
  releaseRef?: string;
  repo?: string;
  sha?: string;
  ref?: string;
  refName?: string;
  branch?: string;
  tag?: string;
  completionStatus?: string;
  dryRun?: boolean;
  forceNotify?: boolean;
}

interface InspectCommanderOptions {
  config: string;
}

interface RenderNotificationCommanderOptions {
  config: string;
  releaseJson: string;
  notifier?: string;
}

interface ValidatePluginCommanderOptions {
  pluginConfigJson?: string;
  requestJson?: string[];
  requestJsonDir?: string;
  hook?: string;
  json?: boolean;
  // Commander stores --no-* options under the non-negated name.
  // --no-exec → options.exec (default true, false when --no-exec is present).
  exec?: boolean;
}

const program = new Command();
program.name('relay');

function withCommonOptions(command: Command): Command {
  return command
    .requiredOption('--config <path>', `path to ${defaultConfigPath}`)
    .option('--provider <pluginRef>', 'override provider plugin for this run')
    .option('--release-profile <name>', 'override release profile for this run')
    .option('--metadata-path <path>', 'path to JSON metadata merge patch')
    .option('--output-json <path>', 'write JSON output to a file')
    .option('--release-ref <ref>', 'override release ref')
    .option('--repo <owner/repo>', 'generic-env repository')
    .option('--sha <sha>', 'generic-env commit sha')
    .option('--ref <ref>', 'generic-env git ref')
    .option('--ref-name <name>', 'generic-env git ref name')
    .option('--branch <branch>', 'generic-env branch')
    .option('--tag <tag>', 'explicit release tag')
    .option('--completion-status <status>', 'pending|completed|failed|unknown')
    .option('--dry-run', 'suppress side effects', false);
}

withCommonOptions(program.command('normalize'))
  .action(async (options: CommonCommanderOptions) => runNormalizeCommand(toNormalizeCommandOptions(options)));

withCommonOptions(program.command('finalize'))
  .option('--force-notify', 'send notifications even when a delivery marker already exists', false)
  .action(async (options: CommonCommanderOptions) => runFinalizeCommand(toFinalizeCommandOptions(options)));

program.command('inspect-config')
  .requiredOption('--config <path>', `path to ${defaultConfigPath}`)
  .action(async (options: InspectCommanderOptions) => runInspectConfigCommand({ config: options.config }));

program.command('render-notification')
  .requiredOption('--config <path>', `path to ${defaultConfigPath}`)
  .requiredOption('--release-json <path>', 'path to normalized release JSON')
  .option('--notifier <pluginRef>', 'override notifier')
  .action(async (options: RenderNotificationCommanderOptions) => runRenderNotificationCommand({
    config: options.config,
    release_json: options.releaseJson,
    notifier: options.notifier,
  }));

program.command('list-plugins')
  .action(async () => runListPluginsCommand());

program.command('validate-plugin <pluginRef>')
  .option('--plugin-config-json <path>', 'path to plugin config JSON object')
  .option('--request-json <path...>', 'one or more request fixture JSON objects')
  .option('--request-json-dir <path>', 'directory of <hook>.request.json fixtures')
  .option('--hook <hook>', 'validate one declared hook instead of all hooks')
  .option('--json', 'emit machine-readable JSON output', false)
  .option('--no-exec', 'run static validation only')
  .action(async (pluginRef: string, options: ValidatePluginCommanderOptions) => runValidatePluginCommand({
    plugin: pluginRef,
    plugin_config_json: options.pluginConfigJson,
    request_json: options.requestJson,
    request_json_dir: options.requestJsonDir,
    hook: options.hook,
    json: options.json,
    // Commander --no-exec stores as options.exec (default=true).
    // Invert: exec=true → run hooks (no_exec=false); exec=false → skip (no_exec=true).
    no_exec: !options.exec,
  }));

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    fail(error.message, 2, error.details);
    return;
  }
  if (error instanceof PluginManifestError || error instanceof PluginAllowlistError || error instanceof PluginLoadError || error instanceof PluginConfigValidationError || error instanceof PluginResponseValidationError || error instanceof ValidatePluginCommandError) {
    fail(error.message, 3, getErrorDetails(error));
    return;
  }
  if (error instanceof ReleaseInvariantError) {
    fail(error.message, 2, error.details);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  fail(message, 5);
});

function toNormalizeCommandOptions(options: CommonCommanderOptions): NormalizeCommandOptions {
  return {
    config: options.config,
    provider: options.provider,
    release_profile: options.releaseProfile,
    metadata_path: options.metadataPath,
    output_json: options.outputJson,
    release_ref: options.releaseRef,
    repo: options.repo,
    sha: options.sha,
    ref: options.ref,
    ref_name: options.refName,
    branch: options.branch,
    tag: options.tag,
    completion_status: options.completionStatus,
    dry_run: options.dryRun ?? false,
  };
}

function toFinalizeCommandOptions(options: CommonCommanderOptions): FinalizeCommandOptions {
  return {
    config: options.config,
    provider: options.provider,
    release_profile: options.releaseProfile,
    metadata_path: options.metadataPath,
    output_json: options.outputJson,
    release_ref: options.releaseRef,
    repo: options.repo,
    sha: options.sha,
    ref: options.ref,
    ref_name: options.refName,
    branch: options.branch,
    tag: options.tag,
    completion_status: options.completionStatus,
    dry_run: options.dryRun ?? false,
    force_notify: options.forceNotify ?? false,
  };
}

function getErrorDetails(error: PluginManifestError | PluginAllowlistError | PluginLoadError | PluginConfigValidationError | PluginResponseValidationError | ValidatePluginCommandError): string[] {
  return 'details' in error && Array.isArray(error.details) ? error.details : [];
}

function fail(message: string, code: number, details?: string[]): void {
  const payload = {
    status: 'error',
    code,
    message,
    details: details ?? [],
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}
