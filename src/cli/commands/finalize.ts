import { writeJsonFile } from '../../core/io/files.js';
import { finalizeRun } from '../../core/orchestration/finalize-run.js';

export interface FinalizeCommandOptions {
  config: string;
  provider?: string;
  release_profile?: string;
  metadata_path?: string;
  output_json?: string;
  dry_run?: boolean;
  repo?: string;
  sha?: string;
  ref?: string;
  ref_name?: string;
  branch?: string;
  tag?: string;
  completion_status?: string;
  release_ref?: string;
}

export async function runFinalizeCommand(options: FinalizeCommandOptions): Promise<void> {
  const result = await finalizeRun({
    configPath: options.config,
    providerOverride: options.provider,
    profileOverride: options.release_profile,
    metadataPath: options.metadata_path,
    dryRun: options.dry_run ?? false,
    args: { ...options },
  });

  if (options.output_json) {
    writeJsonFile(options.output_json, result);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
