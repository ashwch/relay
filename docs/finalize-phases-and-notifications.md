# Finalize Phases and Notifications

This guide explains the last mile of a release run:

```text
GitHub Release is correct
        ↓
optional artifact/package work is checked
        ↓
optional metadata is added
        ↓
downstream notifications are rendered or sent
```

## Why this exists

The framework is not trying to replace every repository's CI pipeline.

Different repositories may already ship with:

- GitHub Actions
- CircleCI
- semantic-release
- manual approvals
- staged asset uploads

The shared rule is smaller:

```text
however the repo shipped,
once it reaches the finalization point,
run the same final-mile phases in the same order
```

That gives every repo the same durable release record, the same notification
shape, and the same machine-readable result without forcing every repo onto one
build system.

## First principles

### 1. GitHub Release is the durable record

A Slack message is useful, but it is not the source of truth.

```text
Git tag + GitHub Release = durable audit record
Slack message            = downstream announcement
```

That is why the finalize flow updates or observes the GitHub Release before
notifications. Some profiles also verify external completion facts before the
GitHub Release is created.

Example:

```text
npm-package profile
  verifies package visibility first
  creates GitHub Release only after the package is installable
```

### 2. Completion gates matter

A release record can exist before the release is truly done.

Example:

```text
asset-release profile
  creates GitHub Release
  uploads assets later
  should notify only after assets are actually complete
```

So notification delivery is gated by:

```text
release.completion.status === "completed"
```

Dry-runs are the exception: they can render previews even when completion is not
complete, because they do not send anything.

### 3. Render and notify are separate jobs

A notifier has two hooks:

```text
render -> build the message payload
notify -> deliver the already-renderable message
```

Why split them?

```text
render is safe to preview locally
notify is the side effect
```

That lets us test formatting without sending real Slack messages.

## Visual phase order

The shared finalize order is:

```text
resolve config
  ↓
normalize provider input
  ↓
profile plan
  ↓
tool observe may return noop
  ↓
release record and artifact phase
  ├─ most profiles: release record -> artifact phase
  └─ package-gated profiles: artifact phase -> release record
  ↓
artifact plugins
  ├─ publish hook when manifest.hooks includes publish
  └─ verify hook when manifest.hooks includes verify
  ↓
metadata enrichers
  └─ enrich hook
  ↓
notifications
  ├─ dry-run: render only
  └─ real run: render, then notify
  ↓
final result JSON
```

The code path lives in:

- `src/core/orchestration/finalize-run.ts`
- `src/core/orchestration/phase-runner.ts`

For `tool-observe` profiles, a release tool can stop the run early:

```text
semantic-release reported a tag
  -> relay verifies the GitHub Release and continues

semantic-release did not report a tag
  -> relay returns status=noop
  -> no GitHub writes, artifact work, or Slack delivery
```

Why?

```text
no release-worthy commits
  -> semantic-release exits successfully
  -> there is no release record to verify
```

That is a normal no-op, not a failed release.

## Artifact phase

Config chooses artifact publishers in order:

```yaml
artifact_publishers:
  - plugin: builtin:github-release-assets
  - plugin: builtin:npm-registry-verify
```

Core does not hard-code what an artifact means.

Instead, each plugin manifest advertises hooks. Core converts those hooks into
runtime calls:

```text
manifest.hooks includes publish -> run publish
manifest.hooks includes verify  -> run verify
```

That keeps ownership clean:

```text
core owns ordering + dry-run propagation
plugin owns artifact-specific behavior
release JSON owns the shared facts after each patch
```

The first built-in artifact plugins now avoid silent fake success:

```text
builtin:github-release-assets -> verifies required GitHub Release assets
builtin:npm-registry-verify   -> verifies package visibility in an npm registry
builtin:s3-manifest-publish   -> dry-run only; real runs fail fast until implemented
```

That means a configured artifact plugin either verifies something concrete,
reports a safe dry-run/skipped result, or fails clearly.

### Artifact-before-release profiles

Some profiles define completion by an external artifact/package becoming
visible.

```text
external artifact/package is visible
  ↓
GitHub Release can safely announce it
```

For those profiles, relay runs the artifact phase before the release-record
phase.

Current example:

```text
npm-package
  -> builtin:npm-registry-verify checks package visibility
  -> only then does relay create/update the GitHub Release
```

Why this ordering exists:

```text
package publish fails
  -> registry visibility check fails
  -> no GitHub Release is created
```

## Metadata enrichment phase

Config chooses enrichers in order:

```yaml
metadata_enrichers:
  - plugin: builtin:github-associated-prs
  - plugin: builtin:github-release-body-pr-parser
```

Enrichers run after artifacts and before notification.

The first built-in enrichers now add concrete pull request context:

```text
builtin:github-associated-prs
  -> reads PRs associated with the release commit from GitHub

builtin:github-release-body-pr-parser
  -> extracts PR references such as #123, PR #123, or pull/123 from release notes
```

Why this timing?

```text
providers know where the run came from
artifact plugins know what was published
metadata enrichers add context after those facts settle
notifiers then see the richest release document
```

## Slack webhook notification path

`builtin:slack-webhook` follows this shape:

```text
release JSON
   ↓ render
Slack incoming-webhook payload
   ↓ notify, only when dry_run=false
HTTP POST to configured webhook
   ↓
delivery metadata in release.notifications.deliveries[]
```

### Config

The recommended config is:

```yaml
notifiers:
  - plugin: builtin:slack-webhook

slack:
  enabled: true
  webhook_secret: SLACK_WEBHOOK_URL

plugin_config:
  builtin:slack-webhook:
    include_rollout_prompt: true
```

Important:

```text
webhook_secret is the environment/secret name
webhook_secret is not the webhook URL itself
```

A real run should provide the secret through the runtime environment or CI
secret store:

```bash
GITHUB_TOKEN=your-token \
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
relay finalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main
```

### Secret boundary

Core gathers secrets and passes them to plugins through the plugin request:

```text
env / CI secrets
  ↓
core resolvePluginSecrets(...)
  ↓
request.secrets
  ↓
plugin notify hook
```

The Slack plugin reads from `request.secrets`, not directly from `process.env`.
That keeps CLI, GitHub Action, tests, and future plugin runtimes on the same
contract.

### Config precedence

For notifier config, the merge order is:

```text
top-level convenience config
  ↓
plugin_config.<plugin_ref>
  ↓
per-selection options
```

Example:

```yaml
slack:
  webhook_secret: SLACK_WEBHOOK_URL

plugin_config:
  builtin:slack-webhook:
    include_rollout_prompt: true

notifiers:
  - plugin: builtin:slack-webhook
    options:
      webhook_secret: RELEASE_CHANNEL_SLACK_WEBHOOK
```

The final `webhook_secret` is `RELEASE_CHANNEL_SLACK_WEBHOOK` because the
selection is closest to the specific run target.

### Slack webhook limitations

Slack incoming webhooks are intentionally simple:

```text
send message: yes
edit message: no framework guarantee
delete message: no framework guarantee
thread message: no framework guarantee
```

So the framework keeps idempotency anchored on GitHub:

```text
release.record.idempotency_key = repository + tag
```

Slack is downstream. GitHub Release is durable.

### Notification markers

For real notifier runs with `delivery_policy: once`, relay writes a tiny marker
asset on the GitHub Release after the downstream webhook succeeds.

```text
real notify phase begins
  ↓
read GitHub Release assets
  ↓
marker exists?
  ├─ yes and not forced -> skip notifier, append skipped delivery record
  ├─ yes and forced     -> send anyway
  └─ no  -> render payload
          ↓
          send Slack webhook
          ↓
          upload .relay-notification-<target>.json
          ↓
          append sent delivery record
```

First principles:

```text
Slack webhook success can happen before a CI rerun
Slack does not give relay a durable webhook message id
GitHub Release assets are durable and tied to the release tag
```

The marker asset body is operational metadata only. It must never contain Slack
webhook URLs or other secret values.

Use `--force-notify` only when a human intentionally wants a repost:

```bash
relay finalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --force-notify
```

First-principles rule:

```text
normal rerun -> marker prevents duplicate Slack
forced rerun -> marker is checked, but does not suppress Slack
```

## Dry-run behavior

Dry-run should answer "what would happen?" without causing side effects.

| Phase | Dry-run behavior |
|---|---|
| GitHub Release | predict URL/status, no mutation |
| artifact publishers | hook receives `dry_run=true` |
| metadata enrichers | hook receives `dry_run=true` |
| Slack render | payload is rendered |
| Slack notify | not called by finalize |
| result JSON | notification delivery status is `rendered` |

This is why the CLI preview flow is safe:

```bash
relay normalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run \
  --output-json /tmp/relay-normalized.json

relay render-notification \
  --config .github/relay.yml \
  --release-json /tmp/relay-normalized.json
```

## Delivery records

Notifier outcomes are appended to:

```text
release.notifications.deliveries[]
```

Typical dry-run delivery:

```json
{
  "plugin": "builtin:slack-webhook",
  "status": "rendered",
  "details": {
    "payload": {
      "text": "web-app production-2026.05.22-9f3c1d2"
    }
  }
}
```

Typical real delivery:

```json
{
  "plugin": "builtin:slack-webhook",
  "status": "sent",
  "details": {
    "delivery": {
      "provider": "slack-webhook",
      "status": "sent",
      "sent": true,
      "webhook_secret": "SLACK_WEBHOOK_URL",
      "http_status": 200
    }
  }
}
```

Typical skipped rerun delivery:

```json
{
  "plugin": "builtin:slack-webhook",
  "status": "skipped",
  "details": {
    "reason": "notification marker exists",
    "marker_name": ".relay-notification-slack-webhook.json"
  }
}
```

The delivery record intentionally stores the secret **name**, not the secret
value.

## How to add a new notifier safely

A notifier should preserve the same shape:

```text
render: no network, no secrets required, payload only
notify: side effect, uses request.secrets, returns delivery metadata
```

Checklist:

- keep render deterministic
- keep notify idempotency anchored on the durable release record, not the
  downstream message system
- honor `request.dry_run`
- return delivery metadata without leaking secret values
- add tests for render-only, dry-run notify, real notify, and missing secret

## Tests that document this behavior

Executable examples live in:

- `tests/slack-webhook-notifier.test.ts`
- `tests/finalize.test.ts`
- `tests/finalize-phases.test.ts`
- `tests/fixtures/artifact-enricher-phases.yml`

Useful focused commands:

```bash
npm test -- --run tests/slack-webhook-notifier.test.ts
npm test -- --run tests/finalize.test.ts
npm test -- --run tests/finalize-phases.test.ts
```

## Files to read next

1. `src/core/orchestration/finalize-run.ts`
2. `src/core/config/resolve-plugin-config.ts`
3. `src/plugins/builtin/notifiers/slack-webhook/index.ts`
4. `src/plugins/builtin/notifiers/slack-webhook/manifest.json`
5. `docs/plugins.md`
6. `docs/config.md`
