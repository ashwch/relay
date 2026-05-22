import { loadConfig } from '../../core/config/load-config.js';
import { resolveNotifierPluginConfig, resolveNotifierSelections } from '../../core/config/resolve-plugin-config.js';
import { loadPlugin } from '../../core/plugins/loader.js';
import { runPluginHook } from '../../core/orchestration/phase-runner.js';
import { readJsonFile } from '../../core/io/files.js';
import { validateNormalizedRelease } from '../../core/release-json/invariants.js';

export interface RenderNotificationCommandOptions {
  config: string;
  release_json: string;
  notifier?: string;
}

export async function runRenderNotificationCommand(options: RenderNotificationCommandOptions): Promise<void> {
  const loaded = loadConfig(options.config);
  const release = validateNormalizedRelease(readJsonFile(options.release_json));
  const configuredNotifiers = resolveNotifierSelections(loaded);
  const notifierRef = options.notifier ?? configuredNotifiers[0]?.plugin;

  if (!notifierRef) {
    throw new Error('no notifier configured');
  }

  const notifierSelection = configuredNotifiers.find((selection) => selection.plugin === notifierRef);
  const notifier = loadPlugin(loaded, notifierRef, 'notifier');
  const result = await runPluginHook({
    manifest: notifier.manifest,
    handler: notifier.handler,
    hook: 'render',
    dryRun: true,
    pluginConfig: resolveNotifierPluginConfig(loaded, notifierSelection ?? { plugin: notifierRef }),
    release,
    args: { ...options },
    env: process.env,
    workspaceRoot: process.cwd(),
  });

  process.stdout.write(`${JSON.stringify(result.response.outputs, null, 2)}\n`);
}
