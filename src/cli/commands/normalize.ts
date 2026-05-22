import { writeJsonFile } from '../../core/io/files.js';
import { normalizeReleaseDocument } from '../../core/orchestration/finalize-run.js';

export interface NormalizeCommandOptions {
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

export async function runNormalizeCommand(options: NormalizeCommandOptions): Promise<void> {
  const release = await normalizeReleaseDocument({
    configPath: options.config,
    providerOverride: options.provider,
    profileOverride: options.release_profile,
    metadataPath: options.metadata_path,
    dryRun: options.dry_run ?? false,
    args: { ...options },
  });

  if (options.output_json) {
    writeJsonFile(options.output_json, release);
  }
  process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
}
