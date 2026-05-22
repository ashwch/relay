import { okResponse, type PluginHandler, type PluginRequest, type PluginResponse } from '../../../../core/plugins/request-response.js';
import type { NormalizedRelease } from '../../../../core/release-json/schema.js';
import type { UnknownMap } from '../../../../core/types/runtime.js';

/**
 * Slack incoming webhook notifier.
 *
 * The important design split is:
 *
 *   render -> pure formatting, safe to run locally and in dry-runs
 *   notify -> network side effect, uses request.secrets, returns metadata
 *
 * Slack webhooks are send-only from the framework's point of view. We do not
 * try to edit/delete/thread messages, and we keep idempotency on the GitHub
 * Release record instead of on Slack.
 */

interface SlackNotifierConfig {
  enabled?: boolean;
  webhook_secret?: string;
  include_rollout_prompt?: boolean;
}

interface SlackTextObject {
  type: 'mrkdwn';
  text: string;
}

interface SlackSectionBlock {
  type: 'section';
  text: SlackTextObject;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackTextObject[];
}

interface SlackWebhookPayload {
  text: string;
  blocks: Array<SlackSectionBlock | SlackContextBlock>;
}

interface SlackWebhookResolution {
  url: string;
  secretName: string;
  source: 'secret';
}

interface SlackWebhookResult {
  httpStatus: number;
  responseBody: string;
}

const defaultSlackWebhookSecret = 'SLACK_WEBHOOK_URL';
const maxSlackResponseBodyLength = 500;
const truncatedResponseSuffix = '...';

export const slackWebhookNotifier: PluginHandler = {
  async render(request) {
    if (!request.release) {
      throw new Error('slack render requires release document');
    }

    const config = readSlackConfig(request.config);
    if (config.enabled === false) {
      return noopResponse({}, 'slack notifier disabled');
    }

    return okResponse({}, { payload: buildSlackPayload(request.release, config) }, 'rendered slack payload');
  },

  async notify(request) {
    if (!request.release) {
      throw new Error('slack notify requires release document');
    }

    const config = readSlackConfig(request.config);
    const payload = buildSlackPayload(request.release, config);
    if (config.enabled === false) {
      return noopResponse({
        delivery: {
          provider: 'slack-webhook',
          status: 'disabled',
          sent: false,
        },
      }, 'slack notifier disabled');
    }

    if (request.dry_run) {
      return noopResponse({
        payload,
        delivery: {
          provider: 'slack-webhook',
          status: 'dry-run',
          sent: false,
          webhook_secret: readWebhookSecretName(config),
        },
      }, 'slack notify dry-run noop');
    }

    const webhook = resolveWebhook(request, config);
    const result = await sendSlackWebhook(webhook.url, payload);
    return okResponse({}, {
      payload,
      delivery: {
        provider: 'slack-webhook',
        status: 'sent',
        sent: true,
        source: webhook.source,
        webhook_secret: webhook.secretName,
        http_status: result.httpStatus,
        response_body: trimResponseBody(result.responseBody),
        sent_at: new Date().toISOString(),
      },
    }, 'sent slack webhook');
  },
};

/**
 * Convert the normalized release document into Slack's incoming-webhook shape.
 *
 * This function intentionally does not read secrets and does not perform
 * network I/O. That makes message previews deterministic and easy to test.
 */
function buildSlackPayload(release: NormalizedRelease, config: SlackNotifierConfig = {}): SlackWebhookPayload {
  const repositoryName = escapeSlackText(release.repository.name);
  const releaseTag = escapeSlackText(release.release.tag);
  const workflowUrl = readOptionalString(release.links.workflow_url);
  const releaseUrl = readOptionalString(release.release.url);
  const releaseLink = releaseUrl ? `<${releaseUrl}|${releaseTag}>` : `\`${releaseTag}\``;
  const contextElements: SlackTextObject[] = [
    {
      type: 'mrkdwn',
      text: workflowUrl ? `<${workflowUrl}|Workflow>` : releaseTag,
    },
  ];

  if (config.include_rollout_prompt) {
    contextElements.push({
      type: 'mrkdwn',
      text: 'Confirm rollout/monitoring owners have checked post-release health.',
    });
  }

  return {
    text: `${repositoryName} ${releaseTag}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${repositoryName}* released ${releaseLink}`,
        },
      },
      {
        type: 'context',
        elements: contextElements,
      },
    ],
  };
}

/**
 * Resolve the concrete webhook URL from the explicit plugin secret bag.
 *
 * The config value is a secret name, not the URL. This prevents checked-in repo
 * config from becoming a secret store and keeps secret access centralized in
 * core orchestration.
 */
function resolveWebhook(request: PluginRequest, config: SlackNotifierConfig): SlackWebhookResolution {
  const secretName = readWebhookSecretName(config);
  const webhookUrl = request.secrets[secretName];
  if (!webhookUrl) {
    throw new Error(`Slack webhook secret ${secretName} is not available`);
  }

  assertHttpsWebhookUrl(webhookUrl);
  return {
    url: webhookUrl,
    secretName,
    source: 'secret',
  };
}

async function sendSlackWebhook(url: string, payload: SlackWebhookPayload): Promise<SlackWebhookResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`Slack webhook request failed with HTTP ${response.status}: ${trimResponseBody(responseBody)}`);
  }

  return {
    httpStatus: response.status,
    responseBody,
  };
}

function readSlackConfig(config: unknown): SlackNotifierConfig {
  if (!isObject(config)) {
    return {};
  }

  return {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : undefined,
    webhook_secret: readOptionalString(config.webhook_secret),
    include_rollout_prompt: typeof config.include_rollout_prompt === 'boolean' ? config.include_rollout_prompt : undefined,
  };
}

function readWebhookSecretName(config: SlackNotifierConfig): string {
  return config.webhook_secret ?? defaultSlackWebhookSecret;
}

function assertHttpsWebhookUrl(url: string): void {
  if (!URL.canParse(url)) {
    throw new Error('Slack webhook URL must be a valid https:// URL');
  }

  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
    throw new Error('Slack webhook URL must be a valid https:// URL');
  }
}

function trimResponseBody(responseBody: string): string {
  if (responseBody.length <= maxSlackResponseBodyLength) {
    return responseBody;
  }

  return `${responseBody.slice(0, maxSlackResponseBodyLength - truncatedResponseSuffix.length)}${truncatedResponseSuffix}`;
}

function noopResponse(outputs: UnknownMap = {}, message?: string): PluginResponse {
  return {
    status: 'noop',
    release_patch: {},
    outputs,
    logs: message ? [{ level: 'info', message }] : [],
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isObject(value: unknown): value is UnknownMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
