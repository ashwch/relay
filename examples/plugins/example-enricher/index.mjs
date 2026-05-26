import { okResponse, runPluginCli } from "@ashwch/relay/plugin-sdk";

runPluginCli(async (request) => {
  const existingPullRequests = Array.isArray(request.release?.pull_requests)
    ? request.release.pull_requests.length
    : 0;
  const summaryLabel = typeof request.config?.summary_label === "string"
    ? request.config.summary_label
    : "Example enricher summary";

  return okResponse({
    extensions: {
      example_enricher: {
        saw_hook: request.hook,
        dry_run: request.dry_run,
        existing_pull_request_count: existingPullRequests,
      },
    },
  }, {
    summary: {
      label: summaryLabel,
      plugin: "example-enricher",
      saw_hook: request.hook,
      existing_pull_request_count: existingPullRequests,
    },
  }, `example-enricher processed hook ${request.hook}`);
});
