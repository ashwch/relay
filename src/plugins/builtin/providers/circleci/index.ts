import { validateConfig } from '../../../../core/config/validate-config.js';
import { okResponse, type PluginHandler } from '../../../../core/plugins/request-response.js';
import { createBaseReleaseDocument } from '../shared.js';

export const circleCiProvider: PluginHandler = {
  async normalize(request) {
    const config = validateConfig(request.config);
    const owner = requireString(request.inputs.env.CIRCLE_PROJECT_USERNAME, 'CIRCLE_PROJECT_USERNAME');
    const repo = requireString(request.inputs.env.CIRCLE_PROJECT_REPONAME, 'CIRCLE_PROJECT_REPONAME');
    const sha = requireString(request.inputs.env.CIRCLE_SHA1, 'CIRCLE_SHA1');
    const tag = request.inputs.env.CIRCLE_TAG;
    const branch = request.inputs.env.CIRCLE_BRANCH ?? 'unknown';
    const ref = tag ? `refs/tags/${tag}` : `refs/heads/${branch}`;
    const refName = tag ?? branch;
    const refType = tag ? 'tag' : 'branch';
    const completionStatus = toCompletionStatus(request.inputs.env.RELEASE_COMPLETION_STATUS);

    const release = createBaseReleaseDocument(config, {
      providerPlugin: request.plugin.name,
      trigger: tag ? 'tag' : 'pipeline',
      ciSystem: 'circleci',
      eventName: tag ? 'tag' : 'workflow-completed',
      eventId: request.inputs.env.CIRCLE_WORKFLOW_ID ?? null,
      receivedAt: new Date().toISOString(),
      owner,
      repo,
      sha,
      ref,
      refName,
      refType,
      stableBranch: config.stable_branches.includes(refName),
      dryRun: request.dry_run,
      workflowUrl: request.inputs.env.CIRCLE_BUILD_URL ?? null,
      completionStatus,
      providerExtension: {
        build_num: request.inputs.env.CIRCLE_BUILD_NUM ?? null,
        workflow_id: request.inputs.env.CIRCLE_WORKFLOW_ID ?? null,
      },
      sourceExtras: {
        vcs_type: request.inputs.env.CIRCLE_REPOSITORY_URL?.includes('github.com') ? 'github' : 'unknown',
      },
    });

    return okResponse(release, {}, 'normalized CircleCI context');
  },
};

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function toCompletionStatus(value: unknown): 'pending' | 'completed' | 'failed' | 'unknown' | undefined {
  if (value === 'pending' || value === 'completed' || value === 'failed' || value === 'unknown') {
    return value;
  }
  return undefined;
}
