import fs from 'node:fs';

/**
 * GitHub Actions provider.
 *
 * First principles:
 * GitHub sends a lot of event-specific data, but downstream release code should
 * not have to care which event shape it came from.
 *
 * This provider converts GitHub-specific environment variables and event JSON
 * into the shared release document used everywhere else.
 */

import { validateConfig } from '../../../../core/config/validate-config.js';
import { readJsonFile } from '../../../../core/io/files.js';
import { okResponse, type PluginHandler } from '../../../../core/plugins/request-response.js';
import type { JsonValue } from '../../../../core/types/json.js';
import { createBaseReleaseDocument, parseRepository } from '../shared.js';

interface GitHubRepositoryEvent {
  default_branch?: string;
}

interface RepositoryDispatchLinks {
  compare_url?: string | null;
  deployment_url?: string | null;
  workflow_url?: string | null;
  [key: string]: JsonValue | undefined;
}

interface RepositoryDispatchPayload {
  repository?: string;
  sha?: string;
  ref?: string;
  ref_name?: string;
  commit_timestamp?: string;
  completion_status?: 'pending' | 'completed' | 'failed' | 'unknown';
  ci_system?: string;
  links?: RepositoryDispatchLinks;
}

interface GitHubEvent {
  action?: string | null;
  repository?: GitHubRepositoryEvent;
  client_payload?: RepositoryDispatchPayload;
}

export const githubActionsProvider: PluginHandler = {
  /**
   * Normalize GitHub Actions context into one CI-agnostic release document.
   *
   * We also support repository_dispatch bridge payloads here so CircleCI or
   * another system can hand off finalization to GitHub-hosted runtime later.
   */
  async normalize(request) {
    const config = validateConfig(request.config);
    const eventPath = request.inputs.env.GITHUB_EVENT_PATH;
    const eventName = request.inputs.env.GITHUB_EVENT_NAME ?? 'unknown';
    const event = readGitHubEvent(eventPath);
    const dispatchPayload = eventName === 'repository_dispatch'
      ? event.client_payload ?? {}
      : {};

    const repoFullName = stringValue(dispatchPayload.repository) ?? request.inputs.env.GITHUB_REPOSITORY;
    if (!repoFullName) {
      throw new Error('GITHUB_REPOSITORY is required');
    }
    const { owner, repo } = parseRepository(repoFullName);

    const sha = stringValue(dispatchPayload.sha) ?? request.inputs.env.GITHUB_SHA;
    const ref = stringValue(dispatchPayload.ref) ?? request.inputs.env.GITHUB_REF ?? 'refs/heads/unknown';
    const refName = stringValue(dispatchPayload.ref_name)
      ?? request.inputs.env.GITHUB_REF_NAME
      ?? ref.replace(/^refs\/(heads|tags)\//, '');
    const refType = ref.startsWith('refs/tags/') ? 'tag' : ref.startsWith('refs/heads/') ? 'branch' : 'unknown';
    const completionStatus = toCompletionStatus(dispatchPayload.completion_status) ?? toCompletionStatus(request.inputs.env.RELEASE_COMPLETION_STATUS);

    if (!sha) {
      throw new Error('GITHUB_SHA is required');
    }

    const release = createBaseReleaseDocument(config, {
      providerPlugin: request.plugin.name,
      trigger: eventName,
      ciSystem: 'github-actions',
      eventName,
      eventAction: stringValue(event.action) ?? null,
      eventId: request.inputs.env.GITHUB_RUN_ID ?? null,
      receivedAt: new Date().toISOString(),
      owner,
      repo,
      defaultBranch: stringValue(event.repository?.default_branch),
      sha,
      ref,
      refName,
      refType,
      stableBranch: config.stable_branches.includes(refName),
      commitTimestamp: stringValue(dispatchPayload.commit_timestamp) ?? null,
      dryRun: request.dry_run,
      workflowUrl: buildWorkflowUrl(repoFullName, request.inputs.env.GITHUB_RUN_ID),
      completionStatus,
      providerExtension: {
        run_attempt: numberValue(request.inputs.env.GITHUB_RUN_ATTEMPT),
        actor: request.inputs.env.GITHUB_ACTOR ?? null,
        dispatch_bridge: eventName === 'repository_dispatch',
      },
      sourceExtras: eventName === 'repository_dispatch' ? { upstream_ci_system: dispatchPayload.ci_system ?? null } : {},
      linkExtras: dispatchPayload.links ?? {},
      workspaceRoot: request.workspace.root,
    });

    return okResponse(release, {}, 'normalized GitHub Actions context');
  },
};

/**
 * Build a stable link back to the source workflow run when GitHub gives us one.
 */
function buildWorkflowUrl(repoFullName: string, runId: string | undefined): string | null {
  if (!runId) {
    return null;
  }
  return `https://github.com/${repoFullName}/actions/runs/${runId}`;
}

function toCompletionStatus(value: unknown): 'pending' | 'completed' | 'failed' | 'unknown' | undefined {
  if (value === 'pending' || value === 'completed' || value === 'failed' || value === 'unknown') {
    return value;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the event payload defensively.
 *
 * Why so defensive?
 * The event file is external input from CI. If it is missing or shaped in an
 * unexpected way, we prefer a safe empty object over leaking provider-specific
 * parsing assumptions deeper into the framework.
 */
function readGitHubEvent(eventPath: string | undefined): GitHubEvent {
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }

  const raw = readJsonFile(eventPath);
  return isGitHubEvent(raw) ? raw : {};
}

function isGitHubEvent(value: unknown): value is GitHubEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
