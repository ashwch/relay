import { validateConfig } from '../../../../core/config/validate-config.js';
import { okResponse, type PluginHandler } from '../../../../core/plugins/request-response.js';
import { createBaseReleaseDocument, parseRepository } from '../shared.js';

// The generic-env provider translates CLI flags and env vars into the shared
// normalized release document.
//
// Visual model:
//
//   CLI flags (--repo, --sha, --branch, ...)
//         ↓  or env vars (RELEASE_REPOSITORY, RELEASE_SHA, ...)
//   generic-env provider
//         ↓
//   normalized release document
//
// This is the provider used for manual invocations, local development, and any
// CI system that passes release context through environment variables.
export const genericEnvProvider: PluginHandler = {
  async normalize(request) {
    const config = validateConfig(request.config);
    const repoFullName = getValue(request.inputs.args.repo) ?? request.inputs.env.RELEASE_REPOSITORY;
    if (!repoFullName) {
      throw new Error('generic env provider requires --repo or RELEASE_REPOSITORY');
    }
    const { owner, repo } = parseRepository(repoFullName);

    const sha = getValue(request.inputs.args.sha) ?? request.inputs.env.RELEASE_SHA;
    const ref = getValue(request.inputs.args.ref) ?? request.inputs.env.RELEASE_REF;
    const refName = getValue(request.inputs.args.ref_name) ?? request.inputs.env.RELEASE_REF_NAME;
    const tag = getValue(request.inputs.args.tag) ?? request.inputs.env.RELEASE_TAG;
    const branch = getValue(request.inputs.args.branch) ?? request.inputs.env.RELEASE_BRANCH;
    const resolvedRef = ref ?? (tag ? `refs/tags/${tag}` : branch ? `refs/heads/${branch}` : undefined);
    const resolvedRefName = refName ?? tag ?? branch;

    if (!sha || !resolvedRef || !resolvedRefName) {
      throw new Error('generic env provider requires sha and one of ref/tag/branch');
    }

    const refType = resolvedRef.startsWith('refs/tags/') ? 'tag' : resolvedRef.startsWith('refs/heads/') ? 'branch' : 'unknown';
    const completionStatus = toCompletionStatus(getValue(request.inputs.args.completion_status) ?? request.inputs.env.RELEASE_COMPLETION_STATUS);

    const release = createBaseReleaseDocument(config, {
      providerPlugin: request.plugin.name,
      trigger: 'manual',
      ciSystem: 'generic-env',
      eventName: 'manual',
      receivedAt: new Date().toISOString(),
      owner,
      repo,
      sha,
      ref: resolvedRef,
      refName: resolvedRefName,
      refType,
      stableBranch: config.stable_branches.includes(resolvedRefName),
      dryRun: request.dry_run,
      workflowUrl: request.inputs.env.RELEASE_WORKFLOW_URL ?? null,
      completionStatus,
      providerExtension: {
        input_args: filterUndefinedValues(request.inputs.args),
      },
    });

    return okResponse(release, {}, 'normalized generic env context');
  },
};

function getValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Strip `undefined` values from runtime args before storing them in the
// provider extension. The JSON-safety validator rejects `undefined` because it
// is not a JSON type, and JSON.stringify naturally drops such keys anyway.
function filterUndefinedValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function toCompletionStatus(value: unknown): 'pending' | 'completed' | 'failed' | 'unknown' | undefined {
  if (value === 'pending' || value === 'completed' || value === 'failed' || value === 'unknown') {
    return value;
  }
  return undefined;
}
