import { listBuiltinPlugins } from '../../core/plugins/loader.js';

export async function runListPluginsCommand(): Promise<void> {
  const manifests = listBuiltinPlugins();
  process.stdout.write(`${JSON.stringify(manifests, null, 2)}\n`);
}
