# Relay

A shared release finalizer for teams with mixed CI and release workflows.

The name "Relay" is deliberate. The framework receives release state from
one system (CI, a release tool, a manual flow) and carries it through the
final mile — GitHub Releases, notifications, metadata enrichment — without
caring how each repo reached ship-ready.

```text
incoming release state from any source
               ↓
           Relay
               ↓
GitHub Release + notifications + shared metadata
```

The name matches the architecture: the framework is a baton pass, not a source
of truth. CI and release tools still own their domains. Relay only owns the
standardized last mile.

The main idea is simple:

```text
whatever CI already does well
        ↓
 build / deploy / publish / semantic-release
        ↓
 normalize the result into one release document
        ↓
 run one shared finalize flow
        ↓
 GitHub Release + shared notifications + shared metadata
```

## Why this repo exists

Different repositories can reach "release complete" in different ways:

- GitHub Actions
- CircleCI
- semantic-release
- manual flows
- asset-heavy flows that finish in stages

That is normal.

What was missing was a **shared last mile**.

This repo provides that last mile.

Examples in this repository intentionally use neutral placeholder names such as:

- `ExampleOrg/web-app`
- `ExampleOrg/component-library`
- `ashwch/relay`

That is deliberate.

The framework is meant to be reusable by any team, not tied to one internal
organization or product line.

Instead of forcing every repo to use the same CI system, it does this:

```text
repo-specific CI stays different
repo-specific build logic stays different
repo-specific deploy logic stays different
                ↓
Relay gives them one shared release contract
```

## First-principles mental model

Think about a release as three separate questions:

### 1. "Where did this release come from?"
That is the job of a **provider plugin**.

Examples:
- `builtin:github-actions`
- `builtin:circleci`
- `builtin:generic-env`

### 2. "What does done mean for this kind of repo?"
That is the job of a **profile plugin**.

Examples:
- `deploy-release`
- `semantic-release`
- `asset-release`

### 3. "Who owns the release record?"
That is the job of **release mode**.

Modes:
- `framework-managed` → framework creates/updates the GitHub Release
- `tool-observe` → some other tool already created it; framework observes it
- `tool-wrap` → framework will eventually run the tool, then observe the result

That separation is the heart of the design.

## The release document

Every run converges on one machine-readable object:

```text
Normalized Release JSON v1
```

Why?

Because once every provider emits the same shape, the rest of the system becomes much easier:

- notifications do not care whether the run came from GitHub Actions or CircleCI
- metadata enrichment does not care whether the release came from semantic-release or a manual deploy
- idempotency logic has one place to look

In short:

```text
many CI inputs
      ↓
one normalized release document
      ↓
many shared outputs
```

## What is implemented right now

### Core
- config loading and validation
- normalized release JSON typing and invariant checks
- plugin manifest loading and compatibility checks
- explicit plugin hook declarations in manifests
- plugin response schema validation + JSON-safety checks
- bounded plugin response size checks before merge-patch application
- external `path:` / `npm:` plugin subprocess execution over stdin/stdout JSON
- minimal external plugin env surface with explicit `request.secrets`
- a shared orchestration loop for `normalize` and `finalize`
- real GitHub Release create / update / observe helpers

### Built-in providers
- GitHub Actions
- CircleCI
- generic env / manual invocation

### Built-in profiles
- deploy-release
- manual-release-pr
- semantic-release
- npm-package
- asset-release
- tag-only-module

### Built-in extension points
- semantic-release observe path
- Slack payload render + incoming webhook delivery
- GitHub Release asset verification
- npm package visibility verification
- PR metadata enrichment from GitHub and release notes

### Surfaces
- CLI
- GitHub composite action
- reusable GitHub workflow

## What is intentionally still scaffold-level

These pieces are intentionally not fully finished yet:

- external plugins now execute through a subprocess boundary, but GitHub-sourced plugin fetching is still not implemented
- `builtin:s3-manifest-publish` is reserved for a future real implementation and fails fast if configured for real use
- `tool-wrap` mode is still reserved for a later pass

That is deliberate.

The current goal is to keep each side effect explicit, legible, and testable before expanding the remaining scaffold-level integrations.

## Why explicit hooks and response validation were added

As the framework moves toward real external plugins, two questions become much
more important:

```text
1. What is core allowed to call?
2. What is core allowed to trust?
```

The new contract answers those questions explicitly.

### 1. Manifests now declare `hooks`

A plugin manifest already described what a plugin *is*.
Now it also describes what core may actually *call* at runtime.

```text
provider           -> normalize
profile            -> plan
release_tool       -> observe / publish
artifact_publisher -> publish / verify
metadata_enricher  -> enrich
notifier           -> render / notify
```

Why add this?

Because `capabilities` and runtime hook selection are not the same thing.
We still keep capabilities for business meaning, but hooks are now the runtime
truth.

```text
capabilities -> what the plugin claims to help with
hooks        -> what core is allowed to invoke
```

That makes reviews easier:

```text
open manifest
   ↓
see exact hooks
   ↓
know which phase-runner calls are legal
```

### 2. Plugin responses now have a schema and safety checks

Before merge-patching plugin output back into the shared release document, core
now validates the plugin response.

Visual model:

```text
plugin hook runs
      ↓
stdout / in-process return value
      ↓
response schema validation
      ↓
JSON-safety validation
      ↓
response size limit
      ↓
merge patch into release document
```

Why add this now?

Because external plugin execution is a trust boundary.
Even for built-ins, we want the contract to be the same shape that future
subprocess plugins must satisfy.

The response validator now rejects things that look harmless in JavaScript but
become ambiguous at a JSON boundary, such as:

- circular references
- `NaN` / non-finite numbers
- functions
- symbols
- missing required top-level fields
- oversized responses

That protects the most important rule in the system:

```text
plugins patch the shared release document
plugins do not get to smuggle arbitrary runtime values into it
```

### 3. External plugins now run out-of-process

The first external execution path is now:

```text
core process
   ↓ build PluginRequest
stdin JSON
   ↓
plugin subprocess
   ↓ stdout JSON
core validation + merge-patch
```

Why do it this way?

Because external plugin code should not run inside the framework process.
That gives us a cleaner trust boundary and keeps future language support open.

The current subprocess rules are intentionally conservative:

- `request.secrets` is the explicit secret channel
- external plugins get a minimal process environment
- external plugins get an empty `request.inputs.env` by default
- plugin-specific config can be validated with manifest `config_schema`
- stdout is size-bounded
- stderr is captured for error context
- hook runtime is time-bounded

That keeps the contract legible:

```text
if a plugin needs something
it should declare it
and core should pass it explicitly
```

### Minimal mental model for an external plugin author

An external plugin does not need to import framework internals.
It only needs to honor one JSON contract.

```text
read PluginRequest JSON from stdin
        ↓
do plugin-specific work
        ↓
write PluginResponse JSON to stdout
```

For JavaScript/TypeScript authors, the framework now exposes a small stable SDK at `@ashwch/relay/plugin-sdk`.

Why add a stable SDK?

```text
same stdin/stdout boilerplate in every plugin
        ↓
more chances to print debug text to stdout
        ↓
more chances to drift on request/response handling
```

The SDK keeps the author loop small and boring:

```text
runPluginCli(...)
  -> read stdin
  -> parse PluginRequest JSON
  -> do a light request-shape check
  -> call your handler
  -> write one PluginResponse JSON object to stdout
```

Very small JavaScript example:

```js
import { okResponse, runPluginCli } from "@ashwch/relay/plugin-sdk";

runPluginCli(async (request) => {
  return okResponse({
    extensions: {
      example_plugin: {
        hook: request.hook,
        dry_run: request.dry_run,
      },
    },
  });
});
```

Minimal manifest shape:

```json
{
  "api_version": "release-framework.plugin/v1",
  "name": "example-plugin",
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

Then allowlist it in repo config:

```yaml
metadata_enrichers:
  - plugin: path:./plugins/example-plugin

plugin_allowlist:
  - path:./plugins/example-plugin
```

The important idea is:

```text
plugin author owns domain behavior
framework owns contract validation and release-document safety
```

If you want the author-facing details next, read:

1. `docs/plugin-authoring.md`
2. `docs/validate-plugin.md`
3. `examples/plugins/README.md`

## Repository status and public-readiness files

The package is still intentionally private:

```json
{
  "private": true
}
```

The repository now includes public-readiness files anyway:

- `LICENSE`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`

Why add them before publishing?

```text
private development now
        ↓
clear contribution/security expectations
        ↓
less cleanup if/when the project becomes public
```

Before any public release, re-check the npm package name/scope and update the
security contact in `SECURITY.md`.

## Repository layout

```text
src/
  cli/
    main.ts                  # user-facing commands
  core/
    config/                  # load + validate repo config
    github/                  # small GitHub API helpers for tags + releases
    release-json/            # normalized release document rules
    types/                   # shared JSON + runtime boundary types
    plugins/                 # manifest loading + plugin lookup
    orchestration/           # the shared finalize flow
  plugins/
    builtin/                 # first-party built-in plugins

actions/
  release-finalize/          # GitHub Action wrapper

examples/
  *.yml                      # copyable config examples for common release styles
  plugins/                   # minimal external plugin examples

.github/workflows/
  release-finalize.yml       # reusable workflow wrapper

schemas/
  *.json                     # JSON schemas for config + manifests + release docs
                             # includes plugin response validation contract

docs/
  config.md                  # annotated config guide
  finalize-phases-and-notifications.md # artifact/enrich/Slack final-mile behavior
  migrating-backend-date-releases.md  # practical backend-style migration path
  plugin-authoring.md        # how to write external plugins against the JSON contract
  plugins.md                 # plugin mental model and extension guide
  release-records.md         # how GitHub Releases and tags are handled
  runtime-surfaces.md        # CLI/action/workflow surface mental model
  standards.md               # local TypeScript standards for this repo
  tool-wrap.md               # reserved future mode for framework-invoked tools
  types.md                   # why shared runtime/JSON types exist
  validate-plugin.md         # focused guide for fast plugin-author validation loops
  versioning.md              # date-based, counter-based, and custom schemas
```

## CLI commands

### Normalize a release input

Use this when you want to see the base release document **before** later phase
hooks run:

```bash
relay normalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

### Finalize a release

Use this when the repo has already reached its true ship point and you want the
full shared phase flow:

```bash
relay finalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

For a real framework-managed GitHub Release mutation, provide GitHub API credentials.
If `builtin:slack-webhook` is enabled, also provide the configured Slack webhook secret, which defaults to `SLACK_WEBHOOK_URL`:

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

To intentionally repost a notification on a rerun, add `--force-notify`.
Normal reruns should omit it so the GitHub Release marker can prevent duplicate
Slack posts.

The framework will then:

```text
look for an existing release by tag
→ verify or create the tag
→ create or update the GitHub Release
→ run configured artifact and metadata phases
→ send configured notifications after completion
→ return one stable machine-readable result
```

Helpful distinction:

```text
normalize -> good for inspecting provider/profile baseline state
finalize  -> good for exercising artifact/enrich/notify plugin phases
```

If you want the step-by-step release-record and final-mile rules in more detail, read:

- `docs/release-records.md`
- `docs/finalize-phases-and-notifications.md`

### Inspect config

Use this to answer:

```text
Which plugins will this repo actually use?
What versioning strategy is configured?
Which finalize phases and hooks will run?
```

This is especially useful now that hook declarations are explicit in manifests.
It gives reviewers a small visual plan of the runtime contract before any real
release run happens.

```bash
relay inspect-config --config .github/relay.yml
```

### Render notification payloads

Use this when working on notifier formatting without sending anything:

```bash
relay render-notification \
  --config .github/relay.yml \
  --release-json .relay/normalized-release.json
```

### Validate one plugin during authoring

Use this when you are writing or debugging a plugin and want fast contract
feedback before wiring it into a larger release flow:

```bash
relay validate-plugin path:./examples/plugins/example-enricher
```

Useful variants:

```bash
# static checks only
relay validate-plugin path:./examples/plugins/example-enricher --no-exec

# one hook only
relay validate-plugin path:./examples/plugins/example-enricher --hook enrich

# machine-readable output
relay validate-plugin path:./examples/plugins/example-enricher --json

# validate plugin-local config from a JSON object file
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --plugin-config-json /tmp/example-plugin-config.json

# validate against a richer hook request fixture
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --request-json examples/plugins/requests/enrich.request.json

# validate a multi-hook plugin against more than one fixture in one run
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json examples/plugins/requests/render.request.json \
                 examples/plugins/requests/notify.request.json

# or point at a fixture directory that contains <hook>.request.json files
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json-dir examples/plugins/requests
```

For fixture details, read:

- `examples/plugins/requests/README.md`

Mental model:

```text
load manifest
→ validate config
→ optionally run dry-run hook execution
→ validate response contract
```

Important distinction:

```text
provider plugins validate full release-config-shaped request.config
most other plugins validate plugin-local request.config
```

And for request fixtures:

```text
one fixture path    -> one fixture-driven hook validation
many fixture paths  -> one validation run per fixture/hook
fixture directory   -> auto-match <hook>.request.json per declared hook
```

For the focused author guide, read:

- `docs/validate-plugin.md`

### List built-ins

```bash
relay list-plugins
```

## Example configs

Copyable examples live in `examples/`:

- `examples/github-release-assets.yml`
- `examples/npm-package-visibility.yml`
- `examples/pr-metadata-enrichment.yml`
- `examples/semantic-release-observe.yml`

Use `inspect-config` on an example to see its phase plan before wiring it into CI:

```bash
relay inspect-config --config examples/github-release-assets.yml
```

## How the finalize flow works

Today the finalize flow is intentionally easy to reason about:

```text
1. load config
2. choose provider/profile/tool plugins
3. normalize CI input into one release document
4. let the profile define what "done" means
5. create, update, or observe the durable GitHub Release record
6. run configured artifact publisher/verifier hooks
7. run configured metadata enricher hooks
8. render or deliver notifications only when allowed
9. return one machine-readable result
```

The code for that lives in:

- `src/core/orchestration/finalize-run.ts`
- `src/core/orchestration/phase-runner.ts`
- `src/core/plugins/loader.ts`
- `src/core/plugins/manifest.ts`
- `src/core/github/releases.ts`
- `src/core/github/tags.ts`

## Why the GitHub Action is a composite action

The action intentionally bootstraps itself:

```text
setup node
→ npm ci
→ npm run build
→ run the thin JS wrapper
```

Why do it this way right now?

Because during early framework development we want:

- one codepath
- no copied shell logic
- no misleading checked-in fake bundle
- the same TypeScript source to drive both CLI and action behavior

This is easier to understand while the contract is still moving.

Later, the action can be bundled for faster production use.

## Example GitHub Actions usage

```yaml
jobs:
  release:
    uses: ashwch/relay/.github/workflows/release-finalize.yml@v1
    with:
      config_path: .github/relay.yml
      provider_plugin: builtin:github-actions
      dry_run: true
      force_notify: false
    secrets: inherit
```

## Local development

### Install

```bash
npm ci
```

### Quality gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

### Circular dependency check

```bash
pnpm dlx madge --extensions ts --circular src
```

## Documentation map

If you specifically want to understand the new plugin contract additions, read
these first:

1. `docs/plugins.md`
2. `docs/plugin-authoring.md`
3. `docs/validate-plugin.md`
4. `src/core/plugins/manifest.ts`
5. `src/core/plugins/subprocess-runner.ts`
6. `src/core/plugins/response-validation.ts`
7. `src/core/orchestration/phase-runner.ts`
8. `schemas/plugin-manifest.schema.json`
9. `schemas/plugin-response.schema.json`

Then continue with the broader repo map below.

## Full documentation map

If you are new to the repo, read these in order:

1. `README.md` ← start here
2. `docs/config.md` ← how repo config works
3. `docs/plugins.md` ← how plugin types fit together
4. `docs/plugin-authoring.md` ← how to write external plugins against the contract
5. `docs/validate-plugin.md` ← how to validate plugins during authoring
6. `docs/release-records.md` ← how tags + GitHub Releases are handled
7. `docs/runtime-surfaces.md` ← CLI/action/workflow mental model
8. `docs/types.md` ← why shared boundary types exist
9. `docs/finalize-phases-and-notifications.md` ← artifact/enrich/Slack final-mile behavior
10. `docs/versioning.md` ← version schema choices and same-day release logic
11. `docs/migrating-backend-date-releases.md` ← practical backend-style migration path
12. `docs/tool-wrap.md` ← why framework-invoked release tools are reserved
13. `docs/standards.md` ← local TS coding standards for this repo
14. `src/core/orchestration/finalize-run.ts` ← the shared run loop
15. `src/core/orchestration/phase-runner.ts` ← the plugin boundary

## Design rules we are trying to protect

```text
CI-agnostic core
explicit plugin refs
one normalized release document
GitHub Release as durable record
Slack as downstream surface
fail closed when something is missing or ambiguous
```

Those rules matter more than any one implementation detail.

If a future change makes the framework more magical but less legible, it is probably the wrong trade.
