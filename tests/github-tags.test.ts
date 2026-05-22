import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * This test file acts as executable documentation for one easy-to-miss GitHub
 * detail: a tag ref is not always a direct commit pointer.
 */

import { createGitHubClient } from '../src/core/github/client.js';
import { readTagTargetSha } from '../src/core/github/tags.js';

const repository = {
  owner: 'ExampleOrg',
  name: 'web-app',
};
const tagName = 'release-2026.05.22';
const tagObjectUrl1 = 'https://api.github.com/repos/ExampleOrg/web-app/git/tags/tag-object-1';
const tagObjectUrl2 = 'https://api.github.com/repos/ExampleOrg/web-app/git/tags/tag-object-2';
const finalCommitUrl = 'https://api.github.com/repos/ExampleOrg/web-app/git/commits/final-commit-sha';

/**
 * Tag tests protect a subtle correctness rule:
 * a Git reference may point at an annotated tag object instead of directly at a
 * commit. The framework still needs to resolve the final commit correctly.
 */
describe('github tag helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves nested annotated tags down to the final commit sha', async () => {
    // Visual model for this fixture:
    //
    //   ref/tags/release-2026.05.22
    //        ↓
    //   tag-object-1
    //        ↓
    //   tag-object-2
    //        ↓
    //   final-commit-sha
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === gitRefUrl(tagName)) {
        return jsonResponse({
          ref: 'refs/tags/release-2026.05.22',
          object: {
            type: 'tag',
            sha: 'tag-object-1',
            url: tagObjectUrl1,
          },
        });
      }

      if (url === tagObjectUrl1) {
        return jsonResponse({
          object: {
            type: 'tag',
            sha: 'tag-object-2',
            url: tagObjectUrl2,
          },
        });
      }

      if (url === tagObjectUrl2) {
        return jsonResponse({
          object: {
            type: 'commit',
            sha: 'final-commit-sha',
            url: finalCommitUrl,
          },
        });
      }

      throw new Error(`unexpected fetch URL ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = createGitHubClient(repository, {});

    await expect(readTagTargetSha(client, tagName)).resolves.toBe('final-commit-sha');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function gitRefUrl(tag: string): string {
  return `https://api.github.com/repos/${repository.owner}/${repository.name}/git/ref/tags/${encodeURIComponent(tag)}`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}
