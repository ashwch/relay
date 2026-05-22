import { afterEach, describe, expect, it, vi } from 'vitest';

import { slackWebhookNotifier } from '../src/plugins/builtin/notifiers/slack-webhook/index.js';
import { buildNormalizedRelease, fixtureReleaseTag } from './helpers/normalized-release.js';
import type { PluginRequest } from '../src/core/plugins/request-response.js';
import type { JsonObject } from '../src/core/types/json.js';
import type { StringMap } from '../src/core/types/runtime.js';

const release = buildNormalizedRelease();

describe('slack webhook notifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a Slack payload without sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const render = slackWebhookNotifier.render;
    if (!render) {
      throw new Error('slack render hook missing');
    }

    const response = await render(buildRequest({
      hook: 'render',
      dryRun: true,
      config: { include_rollout_prompt: true },
    }));

    expect(response.status).toBe('ok');
    expect(response.outputs.payload).toMatchObject({
      text: `web-app ${fixtureReleaseTag}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escapes Slack mrkdwn control characters in release text', async () => {
    const render = slackWebhookNotifier.render;
    if (!render) {
      throw new Error('slack render hook missing');
    }

    const response = await render({
      ...buildRequest({
        hook: 'render',
        dryRun: true,
        config: {},
      }),
      release: buildNormalizedRelease({
        repository: {
          ...release.repository,
          name: 'web&app',
        },
        release: {
          ...release.release,
          tag: 'release<1>&2',
        },
      }),
    });

    expect(JSON.stringify(response.outputs.payload)).toContain('web&amp;app');
    expect(JSON.stringify(response.outputs.payload)).toContain('release&lt;1&gt;&amp;2');
  });

  it('does not send from notify when dry-run is true', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const notify = slackWebhookNotifier.notify;
    if (!notify) {
      throw new Error('slack notify hook missing');
    }

    const response = await notify(buildRequest({
      dryRun: true,
      config: { webhook_secret: 'CUSTOM_SLACK_WEBHOOK' },
    }));

    expect(response.status).toBe('noop');
    expect(response.outputs.delivery).toMatchObject({
      status: 'dry-run',
      sent: false,
      webhook_secret: 'CUSTOM_SLACK_WEBHOOK',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends to the configured webhook secret and returns delivery metadata', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const notify = slackWebhookNotifier.notify;
    if (!notify) {
      throw new Error('slack notify hook missing');
    }

    const response = await notify(buildRequest({
      dryRun: false,
      config: { webhook_secret: 'CUSTOM_SLACK_WEBHOOK' },
      secrets: {
        CUSTOM_SLACK_WEBHOOK: 'https://hooks.slack.test/services/custom',
      },
    }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.test/services/custom', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining(fixtureReleaseTag),
    }));
    expect(response.status).toBe('ok');
    expect(response.outputs.delivery).toMatchObject({
      status: 'sent',
      sent: true,
      webhook_secret: 'CUSTOM_SLACK_WEBHOOK',
      http_status: 200,
    });
  });

  it('rejects non-HTTPS webhook secrets before sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const notify = slackWebhookNotifier.notify;
    if (!notify) {
      throw new Error('slack notify hook missing');
    }

    await expect(notify(buildRequest({
      dryRun: false,
      config: { webhook_secret: 'CUSTOM_SLACK_WEBHOOK' },
      secrets: {
        CUSTOM_SLACK_WEBHOOK: 'http://hooks.slack.test/services/custom',
      },
    }))).rejects.toThrow('Slack webhook URL must be a valid https:// URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when a real notify is missing the webhook secret', async () => {
    const notify = slackWebhookNotifier.notify;
    if (!notify) {
      throw new Error('slack notify hook missing');
    }

    await expect(notify(buildRequest({
      dryRun: false,
      config: { webhook_secret: 'MISSING_SLACK_WEBHOOK' },
    }))).rejects.toThrow('Slack webhook secret MISSING_SLACK_WEBHOOK is not available');
  });
});

function buildRequest(options: {
  hook?: 'render' | 'notify';
  dryRun: boolean;
  config: JsonObject;
  secrets?: StringMap;
}): PluginRequest {
  return {
    plugin_api_version: 1,
    hook: options.hook ?? 'notify',
    dry_run: options.dryRun,
    plugin: {
      name: 'builtin:slack-webhook',
      version: '1.0.0',
    },
    config: options.config,
    release,
    inputs: {
      env: {},
      args: {},
      files: {},
    },
    secrets: options.secrets ?? {},
    workspace: {
      root: process.cwd(),
    },
  };
}
