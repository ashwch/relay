import { createGitHubClient } from '../../../core/github/client.js';
import { okResponse, type PluginHandler, type PluginRequest } from '../../../core/plugins/request-response.js';
import type { JsonObject } from '../../../core/types/json.js';

interface GitHubAssociatedPullRequest {
  number: number;
  title?: string | null;
  html_url: string;
  state?: string;
  merged_at?: string | null;
  user?: {
    login?: string;
  } | null;
}

const githubAssociatedPrsPlugin = 'builtin:github-associated-prs';
const githubReleaseBodyPrParserPlugin = 'builtin:github-release-body-pr-parser';
const pullRequestReferencePattern = /(?:pull\/(\d+)|\bPR\s*#(\d+)|(?<![\w/])#(\d+))/gi;

const githubAssociatedPrsEnricher: PluginHandler = {
  async enrich(request) {
    if (!request.release) {
      throw new Error('github associated PR enrichment requires release document');
    }

    if (request.dry_run) {
      return okResponse({}, {
        provider: githubAssociatedPrsPlugin,
        status: 'dry-run',
        pull_request_count: 0,
      }, 'github associated pull request enrichment dry-run');
    }

    const client = createGitHubClient({
      owner: request.release.repository.owner,
      name: request.release.repository.name,
    }, request.inputs.env);
    const pullRequests = await client.requestJson<GitHubAssociatedPullRequest[]>({
      method: 'GET',
      path: `/repos/${client.repository.owner}/${client.repository.name}/commits/${request.release.git.sha}/pulls`,
    }) ?? [];

    const mappedPullRequests = pullRequests.map(toAssociatedPullRequestJson);
    return okResponse(mergePullRequestsPatch(request, mappedPullRequests), {
      pull_request_count: mappedPullRequests.length,
    }, 'enriched associated GitHub pull requests');
  },
};

const releaseBodyPrParserEnricher: PluginHandler = {
  async enrich(request) {
    if (!request.release) {
      throw new Error('release body PR parser requires release document');
    }

    const parsedPullRequests = parsePullRequestsFromBody(request.release.release.body, request.release.repository.full_name);
    return okResponse(mergePullRequestsPatch(request, parsedPullRequests), {
      pull_request_count: parsedPullRequests.length,
    }, 'parsed pull requests from release body');
  },
};

export const builtinMetadataEnricherHandlers: MetadataEnricherHandlers = {
  [githubAssociatedPrsPlugin]: githubAssociatedPrsEnricher,
  [githubReleaseBodyPrParserPlugin]: releaseBodyPrParserEnricher,
};

type MetadataEnricherHandlers = {
  [pluginRef: string]: PluginHandler;
};

function toAssociatedPullRequestJson(pullRequest: GitHubAssociatedPullRequest): JsonObject {
  return {
    source: githubAssociatedPrsPlugin,
    number: pullRequest.number,
    title: pullRequest.title ?? null,
    url: pullRequest.html_url,
    state: pullRequest.state ?? null,
    merged_at: pullRequest.merged_at ?? null,
    author: pullRequest.user?.login ?? null,
  };
}

function parsePullRequestsFromBody(body: string, repositoryFullName: string): JsonObject[] {
  pullRequestReferencePattern.lastIndex = 0;
  const pullRequestsByNumber = new Map<number, JsonObject>();
  let match = pullRequestReferencePattern.exec(body);

  while (match) {
    const number = Number(match[1] ?? match[2] ?? match[3]);
    if (Number.isInteger(number) && number > 0 && !pullRequestsByNumber.has(number)) {
      pullRequestsByNumber.set(number, {
        source: githubReleaseBodyPrParserPlugin,
        number,
        url: `https://github.com/${repositoryFullName}/pull/${number}`,
      });
    }
    match = pullRequestReferencePattern.exec(body);
  }

  return [...pullRequestsByNumber.values()];
}

function mergePullRequestsPatch(request: PluginRequest, pullRequests: JsonObject[]): JsonObject {
  if (pullRequests.length === 0) {
    return {};
  }

  return {
    pull_requests: mergePullRequests(request.release?.pull_requests ?? [], pullRequests),
  };
}

function mergePullRequests(existingPullRequests: JsonObject[], newPullRequests: JsonObject[]): JsonObject[] {
  const merged = [...existingPullRequests];
  const seenKeys = new Set(merged.map(pullRequestIdentity));
  for (const pullRequest of newPullRequests) {
    const key = pullRequestIdentity(pullRequest);
    if (!seenKeys.has(key)) {
      merged.push(pullRequest);
      seenKeys.add(key);
    }
  }
  return merged;
}

function pullRequestIdentity(pullRequest: JsonObject): string {
  const number = pullRequest.number;
  if (typeof number === 'number') {
    return `number:${number}`;
  }

  const url = pullRequest.url;
  if (typeof url === 'string') {
    return `url:${url}`;
  }

  return `json:${JSON.stringify(pullRequest)}`;
}
