# Config Guide

This file explains `.github/release-framework.yml` from first principles.

## The goal of config

The config file is **not** a pipeline language.

It does not try to describe every step in CI.

Instead, it answers a smaller and more stable question:

```text
When this repo is done shipping,
how should the shared release framework understand that release?
```

That is why the file stays small.

## Small mental model

A config mostly chooses four things:

```text
provider  -> where the run came from
profile   -> what done means
mode      -> who owns the GitHub Release
plugins   -> what extra shared behavior is enabled
```

## Annotated example

The example below uses neutral placeholder names so it can be copied into any
organization without implying a built-in dependency on one company's naming.

If you want additional full examples, also look at:

- `schemas/release-config.schema.json`
- `docs/migrating-backend-date-releases.md`

```yaml
api_version: 1
product_name: Example Web App

# What kind of repo is this?
release_profile: deploy-release

# Who owns the durable GitHub Release record?
release_mode: framework-managed

# Where is the run coming from by default?
provider_plugin: builtin:github-actions

# Which profile plugin defines completion behavior?
profile_plugin: builtin:deploy-release

# No release tool owns this release yet.
tool_plugin: null

# Extra side-effect plugins.
artifact_publishers: []
notifiers:
  - plugin: builtin:slack-webhook
metadata_enrichers:
  - plugin: builtin:github-associated-prs

# Security guardrails for non-built-ins.
plugin_allowlist: []
allow_local_plugins: false

# Which branches count as stable releases?
stable_branches:
  - main

# How should a version be derived?
version_source:
  type: date-sha

# How should the final tag look?
tag_template: production-{date}-{short_sha}

# Where should notes come from?
notes_source:
  type: associated-release-pr

# First-party convenience block for Slack.
slack:
  enabled: true
  webhook_secret: SLACK_WEBHOOK_URL

# Plugin-specific settings live here.
plugin_config:
  builtin:slack-webhook:
    include_rollout_prompt: true
```

## Why some fields feel duplicated

Example:

```yaml
release_profile: deploy-release
profile_plugin: builtin:deploy-release
```

These are related, but they are not the same thing.

- `release_profile` is the stable **human-level name**
- `profile_plugin` is the concrete **runtime implementation**

That split helps with future evolution.

For example, a repo can keep the same business profile name while swapping implementation details later.

## The most important fields

If you care specifically about date-based, counter-based, or backend-friendly
version schemas, also read:

- `docs/versioning.md`

### `release_mode`
This is one of the most important choices.

#### `framework-managed`
Use this when the framework should own the GitHub Release record.

```text
framework figures out tag/version
framework verifies or creates the tag
framework creates or updates the GitHub Release
framework owns idempotency
```

Operational note:

```bash
GITHUB_TOKEN=your-token release-framework finalize ...
```

Without a GitHub token, real mutation cannot happen.

If `builtin:slack-webhook` is configured, real notification delivery also
requires the configured Slack webhook secret, for example:

```bash
GITHUB_TOKEN=your-token \
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
release-framework finalize ...
```

#### `tool-observe`
Use this when another tool already owns the release record.

Best example:

```text
semantic-release already created the tag and GitHub Release
framework should not duplicate that work
framework should only observe + continue
```

#### `tool-wrap`
This is reserved for a future mode where the framework runs a release tool.

```text
framework invokes release tool
→ tool creates tag/release/package
→ framework observes + validates the result
→ framework continues with artifacts, metadata, notifications
```

It is intentionally not implemented yet. Today the runtime fails fast for
`tool-wrap`, because running a release tool can create irreversible tags or
packages. Use `tool-observe` when a tool such as semantic-release has already
run before finalization starts.

For the future design and safety requirements, read:

- `docs/tool-wrap.md`

## Stable branches and prerelease behavior

`stable_branches` answers this question:

```text
Which branch names should produce stable releases?
```

Why that matters:

- stable branches usually mean `prerelease: false`
- non-stable branches usually mean `prerelease: true`
- release tags and downstream notifications often depend on that distinction

## Slack webhook config

`slack.webhook_secret` names the environment variable or CI secret that contains
the incoming webhook URL. It should not contain the webhook URL itself.

```yaml
slack:
  enabled: true
  webhook_secret: SLACK_WEBHOOK_URL
```

Dry-runs and `render-notification` render the payload without sending. A real
`finalize` run sends only after the completion gate is satisfied. Slack incoming
webhooks are send-only, so the framework does not depend on edit/delete/thread
behavior and keeps durable idempotency anchored on the GitHub Release record.

Visual model:

```text
slack.webhook_secret
  -> names a CI secret / environment variable
  -> core copies that value into request.secrets
  -> notifier sends the webhook without knowing about process.env
```

Notifier config is merged in this order:

```text
top-level slack convenience block
  ↓
plugin_config.builtin:slack-webhook
  ↓
notifiers[].options
```

The closest setting wins. For a deeper walkthrough, read:

- `docs/finalize-phases-and-notifications.md`

## Artifact and metadata config

Artifact publishers and metadata enrichers are optional final-mile plugins.

Example asset verification:

```yaml
artifact_publishers:
  - plugin: builtin:github-release-assets

assets:
  required_assets:
    - web-app.zip
    - checksums.txt
```

Example npm visibility verification:

```yaml
artifact_publishers:
  - plugin: builtin:npm-registry-verify

package:
  name: '@example/web-app'
  registry_url: https://registry.npmjs.org
```

`builtin:s3-manifest-publish` is reserved for a future real implementation.
It can participate in dry-run planning, but real publish attempts fail fast.
Use an external plugin when a repository needs S3 manifest publishing before the
built-in implementation exists.

Example PR metadata enrichment:

```yaml
metadata_enrichers:
  - plugin: builtin:github-associated-prs
  - plugin: builtin:github-release-body-pr-parser
```

Visual model:

```text
release record
  ↓
verify assets/packages
  ↓
add PR metadata
  ↓
notify downstream surfaces
```

For the detailed phase behavior, read:

- `docs/finalize-phases-and-notifications.md`

## `plugin_config`
This is the safe escape hatch.

Use it when a plugin needs extra settings that do not belong in the shared core schema.

Example:

```yaml
plugin_config:
  builtin:slack-webhook:
    include_rollout_prompt: true
```

Why it exists:

```text
without plugin_config
plugins would start inventing random top-level keys
that makes the repo harder to understand
```

So the rule is:

- shared fields go in the core config schema
- plugin-specific fields go under `plugin_config.<plugin_ref>`

## Override behavior

The CLI allows temporary per-run overrides.

Example:

```bash
release-framework finalize \
  --config .github/release-framework.yml \
  --provider builtin:circleci \
  --release-profile asset-release
```

Why allow overrides?

Because they are useful for:

- testing
- migration work
- sandboxes
- dispatch bridge flows

But the config file remains the durable source of truth.

## Common examples

### GitHub Actions app deploy

```yaml
release_profile: deploy-release
release_mode: framework-managed
provider_plugin: builtin:github-actions
profile_plugin: builtin:deploy-release
```

### semantic-release repo

```yaml
release_profile: semantic-release
release_mode: tool-observe
provider_plugin: builtin:circleci
profile_plugin: builtin:semantic-release
tool_plugin: builtin:semantic-release
```

### Backend-friendly date releases

```yaml
version_source:
  type: backend-date-release
  counter_source: github-tag
  separator: .
tag_template: release-{version}
```

Why this shape is recommended:

```text
release-{version}
→ keeps the date release visible in the tag
→ lets the framework inspect same-day history later
→ supports first release = plain date, later releases = date + counter
```

### staged asset release

```yaml
release_profile: asset-release
release_mode: framework-managed
provider_plugin: builtin:github-actions
profile_plugin: builtin:asset-release
```

That last one matters because the GitHub Release may exist **before** assets finish uploading.

The profile tells the framework not to confuse "release record exists" with "shipping is complete".

## Good config hygiene

### Prefer explicit built-ins

Good:

```yaml
provider_plugin: builtin:github-actions
```

Less clear:

```yaml
provider_plugin: github-actions
```

The explicit prefix makes loading rules easier to reason about.

### Keep plugin allowlists small

If a repo needs an external plugin, allowlist only that exact ref.

### Do not turn config into CI logic

If you find yourself wanting 50 nested conditionals, pause.

That probably belongs in:

- CI itself
- a profile plugin
- a provider plugin
- a release-tool plugin

not in the repo config file.

## Related files

- `schemas/release-config.schema.json`
- `src/core/config/load-config.ts`
- `src/core/config/validate-config.ts`
- `src/core/orchestration/finalize-run.ts`
- `docs/release-records.md`
- `docs/versioning.md`
- `docs/migrating-backend-date-releases.md`
