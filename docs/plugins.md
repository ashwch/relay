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

Observe mode also has a normal no-op path:

```text
semantic-release reports a tag
  -> relay verifies the durable GitHub Release

semantic-release reports no tag
  -> relay returns status=noop and stops before shared side effects
```

That distinction keeps "no release-worthy commits" from becoming a failed CI
job.

## Artifact publishers

Artifact publishers are responsible for side effects or checks around assets and packages.

Examples:
- GitHub release assets
- npm visibility checks
- staged manifest publication

Visual model:

```text
profile chooses whether release record or artifacts go first
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

Important package-release rule:

```text
npm package visibility is part of completion
  -> npm-registry-verify runs before GitHub Release creation
  -> failed package visibility does not create an early release
```

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

## Hooks vs capabilities

This distinction matters a lot for the plugin ecosystem work.

```text
capabilities -> human/business meaning
hooks        -> runtime call surface
```

Example:

```text
capability: verify_assets
hook:       verify
```

Why split them?

Because these two questions are different:

```text
"What kind of thing does this plugin help with?"
"What function is core allowed to call?"
```

If we used only capabilities for both jobs, the runtime contract would stay too
implicit.

Now the rule is:

```text
core checks manifest.hooks before calling anything
```

That makes plugin behavior easier to review and easier to harden for future
subprocess-based external execution.

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
check declared hook
call hook
validate response shape
validate JSON-safe patch + outputs
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

## Why plugin responses are now validated so strictly

A plugin response crosses a trust boundary.

Even if a plugin is written in TypeScript, the framework still needs a stable
machine-readable contract before it merges anything back into the release
record.

Visual model:

```text
plugin returns response
        ↓
JSON schema check
        ↓
JSON-safety check
        ↓
response size limit check
        ↓
merge patch into normalized release document
```

Why do the extra JSON-safety checks exist if a schema already exists?

Because some JavaScript values are legal at runtime but unsafe or misleading at
serialization boundaries.

Examples:

- `NaN`
- circular references
- functions
- symbols
- `undefined` hidden inside nested objects

Those values can disappear, coerce strangely, or fail late.
We would rather fail early.

That is why `src/core/plugins/response-validation.ts` exists.

Its job is not to make plugins harder to write.
Its job is to keep the shared release document honest.

## Command to inspect the current runtime plan

When debugging or reviewing a repo config, run:

```bash
relay inspect-config --config .github/relay.yml
```

Look especially at:

```text
phase_plan[].plugin
phase_plan[].hooks
```

That output is the easiest way to answer:

```text
Which plugin runs in which phase?
Which hooks are actually callable?
```

Important runtime distinction:

```text
normalize        -> builds the base release document
finalize         -> runs the full shared phase flow
validate-plugin  -> validates one plugin directly as an author loop
```

So if you are testing a metadata enricher or notifier, you usually have two
useful options:

- `validate-plugin` for the fastest contract feedback
- `finalize --dry-run` for the plugin inside the wider shared flow

For multi-hook plugins, `validate-plugin` can now validate more than one
request fixture in one run.
It can also auto-match fixtures from a directory of `<hook>.request.json`
files.
That keeps the author loop short while still preserving the rule that each
fixture belongs to one concrete hook shape.

## Built-in vs external plugins

### Built-ins
Built-ins are part of this repository.

They are the safest and easiest place to start.

### External package plugins
These allow organization-approved extensions without changing core.

### Local path plugins
These are intentionally locked down.

Why?

Because path plugins are the easiest way to accidentally run unreviewed code in CI.

## How external execution works now

The current external execution boundary is subprocess-based.

```text
core builds PluginRequest
        ↓
stdin JSON
        ↓
external plugin process
        ↓
stdout JSON
        ↓
core validates response
        ↓
merge patch into release document
```

This is the first real step beyond built-ins.

Why choose subprocess execution first?

- external code should not run inside the framework process
- hook timeouts are easier to enforce
- stdout size limits are easier to enforce
- stderr can be captured as debug context
- future non-JavaScript plugins stay possible

## External plugin environment rules

The current rule is intentionally strict:

```text
request.secrets   -> explicit secret channel
request.inputs.env -> empty by default for external plugins
process.env       -> minimal runtime env only
```

Why not pass the whole CI environment through?

Because that would weaken the plugin boundary and make plugin behavior depend on
ambient runtime state instead of declared inputs.

If an external plugin needs something sensitive, the long-term preferred path is:

```text
manifest declares it
        ↓
core resolves it
        ↓
request.secrets provides it explicitly
```

## Small author example

The smallest useful external plugin is just a program that speaks JSON over
stdin/stdout.

Visual model:

```text
PluginRequest from core
        ↓ stdin
plugin code
        ↓ stdout
PluginResponse back to core
```

Minimal `plugin-manifest.json`:

```json
{
  "api_version": "relay.plugin/v1",
  "name": "example-enricher",
  "type": "metadata_enricher",
  "plugin_version": "1.0.0",
  "plugin_api_version": 1,
  "framework_version_range": "^0.1.0",
  "entrypoint": {
    "kind": "module",
    "handler": "index.mjs"
  },
  "capabilities": ["enrich"],
  "hooks": ["enrich"],
  "required_inputs": [],
  "required_secrets": [],
  "optional_secrets": [],
  "permissions": {},
  "supports": {
    "dry_run": true,
    "local": true
  },
  "outputs": [],
  "trust": {
    "level": "external-allowlisted",
    "allow_in_ci": true
  }
}
```

Minimal `index.mjs`:

```js
import { okResponse, runPluginCli } from "@ashwch/relay/plugin-sdk";

runPluginCli(async (request) => {
  return okResponse({
    extensions: {
      example_enricher: {
        saw_hook: request.hook,
      },
    },
  });
});
```

Why show such a tiny example?

Because the first-principles contract is more important than any one language
or framework helper. The SDK just removes repetitive stdin/stdout boilerplate:

```text
accept request JSON
return response JSON
keep the patch small and explicit
```

## How to wire that example into a repo

```yaml
metadata_enrichers:
  - plugin: path:./plugins/example-enricher

plugin_allowlist:
  - path:./plugins/example-enricher
```

Then inspect the planned runtime contract before a real run:

```bash
relay inspect-config --config .github/relay.yml
```

And look for:

```text
phase_plan[].plugin
phase_plan[].hooks
```

## How to inspect what a repo will use

```bash
relay inspect-config --config .github/relay.yml
```

That command is important during migration because it answers:

```text
Which concrete plugins will run for this repo?
```

## How to inspect all built-ins

```bash
relay list-plugins
```

## Files to read next

If you want the author-facing guide first, start here:

1. `docs/plugin-authoring.md`
2. `docs/validate-plugin.md`

If you want the code path, read these in order:

1. `src/core/plugins/manifest.ts`
2. `src/core/plugins/loader.ts`
3. `src/core/plugins/config-validation.ts`   ← plugin-local config boundary
4. `src/core/plugins/subprocess-runner.ts`   ← external process boundary
5. `src/core/plugins/response-validation.ts` ← plugin output trust boundary
6. `src/core/orchestration/phase-runner.ts`
7. `src/core/orchestration/finalize-run.ts`
8. `src/core/release-json/merge-patch.ts`
9. `src/core/types/json.ts`
10. `src/core/types/runtime.ts`
11. `src/plugins/builtin/**`
