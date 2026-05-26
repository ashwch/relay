// Minimal example notifier that demonstrates both the render and notify hooks.
//
// Visual model:
//
//   PluginRequest (hook=render)
//         ↓
//   build notification payload (no side effects)
//         ↓
//   PluginResponse with outputs.payload
//
//   PluginRequest (hook=notify)
//         ↓
//   simulate delivery (dry_run=true → no real HTTP call)
//         ↓
//   PluginResponse with noop status
//
// Important rule for subprocess plugins:
//   stdout → PluginResponse JSON only
//   stderr → debug/log text
import { errorResponse, noopResponse, okResponse, runPluginCli } from "@ashwch/relay/plugin-sdk";

runPluginCli(async (request) => {
  if (request.hook === "render") {
    // Render: build a notification payload without side effects.
    //
    // This hook is safe in dry-run mode. It returns the message that *would*
    // be sent so authors can preview formatting without delivery.
    const releaseVersion = request.release?.release?.version ?? "unknown";
    const releaseTag = request.release?.release?.tag ?? "unknown";
    const repoFullName = request.release?.repository?.full_name ?? "unknown";

    return okResponse({}, {
      payload: {
        text: `:rocket: *${repoFullName}* released \`${releaseVersion}\` (tag \`${releaseTag}\`)`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:rocket: *<https://github.com/${repoFullName}/releases/tag/${releaseTag}|${repoFullName} ${releaseVersion}>*`,
            },
          },
        ],
      },
    }, `example-notifier rendered payload for ${repoFullName} ${releaseVersion}`);
  }

  if (request.hook === "notify") {
    // Notify: simulate delivery of a previously-rendered payload.
    //
    // In dry-run mode, this hook returns noop to indicate "would have
    // delivered, but skipped real side effects."
    //
    // In a real plugin, this is where you would read request.secrets for
    // the webhook URL and POST the notification payload.
    const hasWebhookSecret = typeof request.secrets?.SLACK_WEBHOOK_URL === "string"
      && request.secrets.SLACK_WEBHOOK_URL.length > 0;

    if (request.dry_run) {
      return noopResponse({
        delivery: {
          dry_run: true,
          webhook_configured: hasWebhookSecret,
        },
      }, "example-notifier skipped delivery (dry_run=true)");
    }

    if (!hasWebhookSecret) {
      return errorResponse("no SLACK_WEBHOOK_URL secret configured", {
        outputs: {
          delivery: {
            dry_run: false,
            webhook_configured: false,
          },
        },
        log_message: "example-notifier cannot deliver: no webhook secret configured",
      });
    }

    return okResponse({}, {
      delivery: {
        dry_run: false,
        webhook_configured: true,
      },
    }, "example-notifier delivered notification");
  }

  // Unknown hook — should not happen if the manifest declares hooks correctly.
  return errorResponse(`example-notifier received unexpected hook: ${request.hook}`);
});
