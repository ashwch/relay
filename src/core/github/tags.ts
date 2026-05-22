import type { GitHubClient } from './client.js';

/**
 * Tag helpers.
 *
 * The release framework treats tag state as part of release correctness.
 * If a tag already exists but points at the wrong commit, creating or updating a
 * release would silently describe the wrong code. We fail instead.
 */
interface GitHubReferenceResponse {
  ref: string;
  object: {
    type: 'commit' | 'tag';
    sha: string;
    url: string;
  };
}

interface GitHubAnnotatedTagResponse {
  object: {
    sha: string;
    type: 'commit' | 'tag';
    url: string;
  };
}

interface GitHubRepositoryTagResponse {
  name: string;
  commit: {
    sha: string;
  };
}

export interface RepositoryTagSummary {
  name: string;
  commitSha: string;
}

/**
 * Resolve the final commit SHA for a tag name.
 *
 * Important detail:
 * a tag ref may point directly at a commit, or it may point at one or more
 * annotated tag objects first. Downstream release correctness depends on us
 * resolving all the way to the final commit.
 */
export async function readTagTargetSha(client: GitHubClient, tag: string): Promise<string | null> {
  const reference = await client.requestJson<GitHubReferenceResponse>({
    method: 'GET',
    path: `/repos/${client.repository.owner}/${client.repository.name}/git/ref/tags/${encodeURIComponent(tag)}`,
    allowNotFound: true,
  });

  if (!reference) {
    return null;
  }

  if (reference.object.type === 'commit') {
    return reference.object.sha;
  }

  return readAnnotatedTagTargetSha(client, reference.object.url, new Set<string>());
}

/**
 * Follow annotated tag objects until we reach a commit.
 *
 * We also track visited URLs so a malformed recursive tag chain fails clearly
 * instead of looping forever.
 */
async function readAnnotatedTagTargetSha(
  client: GitHubClient,
  url: string,
  visitedUrls: Set<string>,
): Promise<string | null> {
  if (visitedUrls.has(url)) {
    throw new Error(`detected recursive annotated tag chain at ${url}`);
  }

  visitedUrls.add(url);
  const annotatedTag = await client.requestUrlJson<GitHubAnnotatedTagResponse>({
    method: 'GET',
    url,
  });

  if (!annotatedTag) {
    return null;
  }

  if (annotatedTag.object.type === 'commit') {
    return annotatedTag.object.sha;
  }

  return readAnnotatedTagTargetSha(client, annotatedTag.object.url, visitedUrls);
}

/**
 * Create a lightweight tag ref when the framework is responsible for creating
 * the release record and no tag exists yet.
 */
/**
 * List repository tags with their associated commit SHAs.
 *
 * We use this for counter-based versioning schemes where the next release of a
 * day depends on what tags already exist.
 */
export async function listRepositoryTags(client: GitHubClient): Promise<RepositoryTagSummary[]> {
  const tags = await client.requestJson<GitHubRepositoryTagResponse[]>({
    method: 'GET',
    path: `/repos/${client.repository.owner}/${client.repository.name}/tags?per_page=100`,
  });

  return (tags ?? []).map((tag) => ({
    name: tag.name,
    commitSha: tag.commit.sha,
  }));
}

export async function createTagReference(client: GitHubClient, tag: string, sha: string): Promise<void> {
  client.requireToken();
  await client.requestJson({
    method: 'POST',
    path: `/repos/${client.repository.owner}/${client.repository.name}/git/refs`,
    body: {
      ref: `refs/tags/${tag}`,
      sha,
    },
  });
}

/**
 * Refuse to continue if a tag points at the wrong commit.
 *
 * This protects the framework from publishing a release record that describes
 * the wrong code.
 */
export function assertExpectedTagTarget(tag: string, actualSha: string | null, expectedSha: string): void {
  if (!actualSha) {
    throw new Error(`release tag ${tag} does not exist`);
  }

  if (actualSha !== expectedSha) {
    throw new Error(`release tag ${tag} points to ${actualSha}, expected ${expectedSha}`);
  }
}
