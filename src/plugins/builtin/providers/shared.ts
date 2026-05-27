import type { ReleaseConfig } from '../../../core/config/types.js';
import { releaseSchemaVersion } from '../../../core/constants.js';
import { buildCoreReleaseFields, type NormalizedRelease } from '../../../core/release-json/schema.js';
import type { UnknownMap } from '../../../core/types/runtime.js';

export interface BaseProviderInput {
  providerPlugin: string;
  trigger: string;
  ciSystem: string;
  eventName: string;
  eventAction?: string | null;
  eventId?: string | null;
  receivedAt: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  sha: string;
  ref: string;
  refName: string;
  refType: 'branch' | 'tag' | 'unknown';
  stableBranch: boolean;
  commitTimestamp?: string | null;
  dryRun: boolean;
  workflowUrl?: string | null;
  completionStatus?: NormalizedRelease['completion']['status'];
  providerExtension?: UnknownMap;
  sourceExtras?: UnknownMap;
  linkExtras?: UnknownMap;
  workspaceRoot: string;
}

export function createBaseReleaseDocument(config: ReleaseConfig, input: BaseProviderInput): NormalizedRelease {
  const now = new Date(input.receivedAt);
  const shortSha = input.sha.slice(0, 7);
  const coreFields = buildCoreReleaseFields(config, {
    owner: input.owner,
    repo: input.repo,
    sha: input.sha,
    shortSha,
    refName: input.refName,
    stableBranch: input.stableBranch,
    completionStatus: input.completionStatus,
    dryRun: input.dryRun,
    providerPlugin: input.providerPlugin,
    trigger: input.trigger,
    now,
    workspaceRoot: input.workspaceRoot,
  });

  return {
    schema_version: releaseSchemaVersion,
    run: {
      id: `${input.receivedAt}-${shortSha}`,
      dry_run: input.dryRun,
      provider: input.providerPlugin,
      trigger: input.trigger,
    },
    source: {
      ci_system: input.ciSystem,
      event_name: input.eventName,
      event_action: input.eventAction ?? null,
      event_id: input.eventId ?? null,
      received_at: input.receivedAt,
      ...input.sourceExtras,
    },
    repository: {
      owner: input.owner,
      name: input.repo,
      full_name: `${input.owner}/${input.repo}`,
      ...(input.defaultBranch ? { default_branch: input.defaultBranch } : {}),
      url: `https://github.com/${input.owner}/${input.repo}`,
    },
    git: {
      ref: input.ref,
      ref_name: input.refName,
      ref_type: input.refType,
      sha: input.sha,
      short_sha: shortSha,
      stable_branch: input.stableBranch,
      commit_timestamp: input.commitTimestamp ?? null,
    },
    profile: coreFields.profile,
    release: coreFields.release,
    completion: coreFields.completion,
    artifacts: [],
    packages: [],
    pull_requests: [],
    notifications: coreFields.notifications,
    links: {
      workflow_url: input.workflowUrl ?? null,
      commit_url: `https://github.com/${input.owner}/${input.repo}/commit/${input.sha}`,
      compare_url: null,
      deployment_url: null,
      ...input.linkExtras,
    },
    extensions: {
      [input.providerPlugin]: input.providerExtension ?? {},
    },
  };
}

export function parseRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new Error(`invalid repository ${fullName}`);
  }
  return { owner, repo };
}
