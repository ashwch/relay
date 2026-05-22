# Plugin Guide

This file explains the plugin system in plain language.

## Why plugins exist

The framework needs to stay reusable across many repositories.

If the core hard-coded every CI system, every release tool, and every release style, it would quickly become brittle.

So the design is:

```text
core = stable rules
plugins = environment-specific behavior
```

## The six plugin types

```text
provider           -> where the run came from
profile            -> what done means
release_tool       -> tool-specific release ownership
artifact_publisher -> assets/packages/checks
notifier           -> message rendering/delivery
metadata_enricher  -> extra context
```

## Visual flow

```text
provider
  ↓
normalized release document
  ↓
profile
  ↓
release tool / core release record
  ↓
artifact publishers
  ↓
metadata enrichers
  ↓
notifiers
```

The most important point is this:

```text
plugins do not pass random custom objects to each other
plugins communicate through one shared release document
```

That keeps the system legible.

## Provider plugins

A provider plugin answers:

```text
What happened in CI, and how do we describe it in a stable shape?
```

Examples:
- `builtin:github-actions`
- `builtin:circleci`
- `builtin:generic-env`

All three can describe the same logical release.

That is why we normalize first.

## Profile plugins

A profile plugin answers:

```text
For this kind of repository, when is release work truly complete?
```

Examples:

### `deploy-release`
Use when a deployment succeeding is the ship point.

### `semantic-release`
Use when semantic-release already owns tag + release creation.

### `asset-release`
Use when the release record may exist before assets are actually ready.

This is the plugin type that prevents workflow-specific timing rules from leaking into core.

## Release-tool plugins

A release-tool plugin answers:

```text
How do we talk to a release tool without duplicating its job?
```

Current first tool:
- `builtin:semantic-release`

The current implementation starts in **observe mode**.

Why?

Because the biggest migration risk is accidental duplication.

We would rather:

```text
observe an existing semantic-release GitHub Release correctly
```

than:

```text
accidentally create a second one
```

## Artifact publishers

Artifact publishers are responsible for side effects or checks around assets and packages.

Examples:
- GitHub release assets
- npm visibility checks
- staged manifest publication

Visual model:

```text
release record is ready
        ↓
artifact publisher #1
  ├─ publish, if supported
  └─ verify, if supported
        ↓
artifact publisher #2
  ├─ publish, if supported
  └─ verify, if supported
```

Core owns the order. The plugin owns the artifact-specific behavior.

The first-party implementations now avoid silent fake success:

- `builtin:github-release-assets` verifies configured release asset names
- `builtin:npm-registry-verify` verifies package visibility in an npm registry
- `builtin:s3-manifest-publish` is dry-run only and fails fast for real runs
  until a real S3 implementation exists

That keeps the phase safe: plugins either verify something concrete, report a
safe dry-run/skipped result, or fail clearly.

For the detailed final-mile behavior, read:

- `docs/finalize-phases-and-notifications.md`

## Metadata enrichers

Metadata enrichers add context that is nice to have, but not always required to create the release record itself.

Examples:
- associated pull requests
- PRs parsed from a release body

Visual model:

```text
provider facts
  + release record facts
  + artifact facts
        ↓
metadata enrichers
        ↓
notifier sees the richest release document
```

The finalize flow runs selected metadata enrichers in configured order after the
artifact phase and before notification rendering/delivery.

The first built-ins now add real PR context:

- `builtin:github-associated-prs` reads PRs associated with the release commit
- `builtin:github-release-body-pr-parser` parses PR references from release notes

Why separate them from providers?

Because not every run starts with the same metadata available, and not every enrichment belongs at normalization time.

## Notifiers

A notifier does two separate jobs:

```text
render -> what should the message look like?
notify -> how should it be delivered?
```

That split matters.

It lets us:
- preview messages in dry-run mode
- unit test formatting without real delivery
- keep delivery concerns separate from presentation concerns

`builtin:slack-webhook` now implements both hooks:

- `render` returns a Slack incoming-webhook payload without network I/O
- `notify` sends that payload to the configured webhook when `dry_run=false`

Webhook secrets are selected through config. The first-party convenience block is:

```yaml
slack:
  enabled: true
  webhook_secret: SLACK_WEBHOOK_URL
```

The value of `webhook_secret` is the environment/secret name, not the webhook
URL itself. Slack incoming webhooks are send-only: the framework does not assume
message edit, delete, or thread guarantees.

Visual model:

```text
render hook
  -> returns payload
  -> safe in dry-run and local previews

notify hook
  -> uses request.secrets[webhook_secret]
  -> sends HTTP POST only when dry_run=false
  -> returns delivery metadata
```

For command examples, delivery records, config precedence, and dry-run behavior,
read:

- `docs/finalize-phases-and-notifications.md`

## Explicit plugin refs

Plugin refs are intentionally explicit:

```text
builtin:...
npm:...
path:...
```

Why be strict?

Because implicit discovery is confusing and unsafe.

We do **not** want the framework to silently load arbitrary code just because it happens to exist somewhere in the workspace.

## What a manifest is for

Every plugin has a manifest.

The manifest tells core:

- what the plugin is
- which type it belongs to
- which hooks it supports
- which framework versions it works with
- what permissions and secrets it expects

Think of the manifest as the plugin's contract card.

## How plugins meet the release document

A useful mental model is:

```text
provider writes the first draft
profile patches timing rules
release tool patches ownership facts
other plugins patch only the fields they own
```

That is why the framework uses merge-patch style updates instead of letting
plugins replace the whole document.

## The plugin boundary in code

The most important runtime boundary lives here:

- `src/core/orchestration/phase-runner.ts`

That file is intentionally small.

Its job is:

```text
build request
call hook
validate response shape
merge release patch
fail clearly on bad plugin behavior
```

Why keep it small?

Because plugin execution is a trust boundary.

Smaller code is easier to audit.

## How loading works before execution

Before a plugin can run, the framework first has to answer:

```text
What manifest are we talking about?
What type of plugin is it supposed to be?
Is it allowed to load at all?
```

That logic lives in:

- `src/core/plugins/loader.ts`
- `src/core/plugins/manifest.ts`

Visual model:

```text
plugin ref from config
        ↓
resolve path / built-in entry
        ↓
read manifest
        ↓
validate schema + framework version
        ↓
only then allow runtime execution planning
```

That separation is important.

It means the framework can inspect plugin contracts before it becomes more
permissive about actually running external code.

## Built-in vs external plugins

### Built-ins
Built-ins are part of this repository.

They are the safest and easiest place to start.

### External package plugins
These will eventually allow organization-approved extensions without changing core.

### Local path plugins
These are intentionally locked down.

Why?

Because path plugins are the easiest way to accidentally run unreviewed code in CI.

## How to inspect what a repo will use

```bash
release-framework inspect-config --config .github/release-framework.yml
```

That command is important during migration because it answers:

```text
Which concrete plugins will run for this repo?
```

## How to inspect all built-ins

```bash
release-framework list-plugins
```

## Files to read next

If you want the code path, read these in order:

1. `src/core/plugins/manifest.ts`
2. `src/core/plugins/loader.ts`
3. `src/core/orchestration/phase-runner.ts`
4. `src/core/orchestration/finalize-run.ts`
5. `src/core/release-json/merge-patch.ts`
6. `src/core/types/json.ts`
7. `src/core/types/runtime.ts`
8. `src/plugins/builtin/**`
