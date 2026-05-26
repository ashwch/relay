import type { EnvMap } from '../types/runtime.js';

/**
 * Minimal GitHub API client.
 *
 * We keep this client intentionally small and readable.
 * The release framework only needs a narrow set of GitHub operations right now,
 * so a tiny explicit wrapper is easier to audit than a large abstraction layer.
 */
export interface GitHubRepositoryRef {
  owner: string;
  name: string;
}

export interface GitHubRequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  allowNotFound?: boolean;
}

export interface GitHubAbsoluteRequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  body?: unknown;
  allowNotFound?: boolean;
}

export interface GitHubClient {
  repository: GitHubRepositoryRef;
  token?: string;
  apiBaseUrl: string;
  requireToken(): void;
  requestJson<T>(options: GitHubRequestOptions): Promise<T | null>;
  requestUrlJson<T>(options: GitHubAbsoluteRequestOptions): Promise<T | null>;
}

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(message);
  }
}

export class MissingGitHubTokenError extends Error {
  constructor() {
    super('GitHub API access requires GITHUB_TOKEN or GH_TOKEN for this operation');
  }
}

interface InternalRequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  body?: unknown;
  token?: string;
  allowNotFound?: boolean;
}

const defaultGitHubApiUrl = 'https://api.github.com';
const gitHubApiVersion = '2022-11-28';
const gitHubUserAgent = 'relay';

export function createGitHubClient(
  repository: GitHubRepositoryRef,
  env: EnvMap,
): GitHubClient {
  const token = readOptionalEnv(env, 'GITHUB_TOKEN') ?? readOptionalEnv(env, 'GH_TOKEN');
  const apiBaseUrl = (readOptionalEnv(env, 'GITHUB_API_URL') ?? defaultGitHubApiUrl).replace(/\/$/, '');

  return {
    repository,
    token,
    apiBaseUrl,
    requireToken() {
      if (!token) {
        throw new MissingGitHubTokenError();
      }
    },
    async requestJson<T>(options: GitHubRequestOptions): Promise<T | null> {
      return requestJson<T>({
        method: options.method,
        url: `${apiBaseUrl}${options.path}`,
        body: options.body,
        token,
        allowNotFound: options.allowNotFound,
      });
    },
    async requestUrlJson<T>(options: GitHubAbsoluteRequestOptions): Promise<T | null> {
      return requestJson<T>({
        method: options.method,
        url: options.url,
        body: options.body,
        token,
        allowNotFound: options.allowNotFound,
      });
    },
  };
}

/**
 * One tiny request wrapper for GitHub API calls.
 *
 * Why this helper exists:
 * - every request should set the same headers
 * - every request should parse empty bodies the same way
 * - every request should surface failures with the same error shape
 */
async function requestJson<T>(options: InternalRequestOptions): Promise<T | null> {
  const response = await fetch(options.url, {
    method: options.method,
    headers: buildHeaders(options.token, options.body !== undefined),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const responseBody = await readResponseBody(response);
  if (response.status === 404 && options.allowNotFound) {
    return null;
  }

  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub API request failed: ${options.method} ${options.url}`,
      response.status,
      responseBody,
    );
  }

  return responseBody as T;
}

/**
 * Build the small set of headers we want on every GitHub request.
 */
function buildHeaders(token: string | undefined, hasJsonBody: boolean): Headers {
  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    'User-Agent': gitHubUserAgent,
    'X-GitHub-Api-Version': gitHubApiVersion,
  });

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (hasJsonBody) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

/**
 * Read the response body conservatively.
 *
 * We read text first so we can distinguish:
 * - truly empty body
 * - JSON body
 * - plain text error body
 */
async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (text.length === 0) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  }

  return text;
}

function readOptionalEnv(env: EnvMap, key: string): string | undefined {
  const value = env[key];
  return value && value.length > 0 ? value : undefined;
}
