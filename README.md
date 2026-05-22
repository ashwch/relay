# release-framework

A shared release finalizer for teams with mixed CI and release workflows.

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
- `your-org/release-framework`

That is deliberate.

The framework is meant to be reusable by any team, not tied to one internal
organization or product line.

Instead of forcing every repo to use the same CI system, it does this:

```text
repo-specific CI stays different
repo-specific build logic stays different
repo-specific deploy logic stays different
                ↓
release-framework gives them one shared release contract
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

- external `npm:` and `path:` plugins are validated and resolved, but not executed yet
- `builtin:s3-manifest-publish` is reserved for a future real implementation and fails fast if configured for real use
- `tool-wrap` mode is still reserved for a later pass

That is deliberate.

The current goal is to keep each side effect explicit, legible, and testable before expanding the remaining scaffold-level integrations.

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

.github/workflows/
  release-finalize.yml       # reusable workflow wrapper

schemas/
  *.json                     # JSON schemas for config + manifests + release docs

docs/
  config.md                  # annotated config guide
  finalize-phases-and-notifications.md # artifact/enrich/Slack final-mile behavior
  migrating-backend-date-releases.md  # practical backend-style migration path
  plugins.md                 # plugin mental model and extension guide
  release-records.md         # how GitHub Releases and tags are handled
  runtime-surfaces.md        # CLI/action/workflow surface mental model
  standards.md               # local TypeScript standards for this repo
  tool-wrap.md               # reserved future mode for framework-invoked tools
  types.md                   # why shared runtime/JSON types exist
  versioning.md              # date-based, counter-based, and custom schemas
```

## CLI commands

### Normalize a release input

Use this when you want to see the release document **before** side effects:

```bash
release-framework normalize \
  --config .github/release-framework.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

### Finalize a release

Use this when the repo has already reached its true ship point:

```bash
release-framework finalize \
  --config .github/release-framework.yml \
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
  release-framework finalize \
  --config .github/release-framework.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main
```

The framework will then:

```text
look for an existing release by tag
→ verify or create the tag
→ create or update the GitHub Release
→ run configured artifact and metadata phases
→ send configured notifications after completion
→ return one stable machine-readable result
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

```bash
release-framework inspect-config --config .github/release-framework.yml
```

### Render notification payloads

Use this when working on notifier formatting without sending anything:

```bash
release-framework render-notification \
  --config .github/release-framework.yml \
  --release-json .release-framework/normalized-release.json
```

### List built-ins

```bash
release-framework list-plugins
```

## Example configs

Copyable examples live in `examples/`:

- `examples/github-release-assets.yml`
- `examples/npm-package-visibility.yml`
- `examples/pr-metadata-enrichment.yml`
- `examples/semantic-release-observe.yml`

Use `inspect-config` on an example to see its phase plan before wiring it into CI:

```bash
release-framework inspect-config --config examples/github-release-assets.yml
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
    uses: your-org/release-framework/.github/workflows/release-finalize.yml@v1
    with:
      config_path: .github/release-framework.yml
      provider_plugin: builtin:github-actions
      dry_run: true
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

If you are new to the repo, read these in order:

1. `README.md` ← start here
2. `docs/config.md` ← how repo config works
3. `docs/plugins.md` ← how plugin types fit together
4. `docs/release-records.md` ← how tags + GitHub Releases are handled
5. `docs/runtime-surfaces.md` ← CLI/action/workflow mental model
6. `docs/types.md` ← why shared boundary types exist
7. `docs/finalize-phases-and-notifications.md` ← artifact/enrich/Slack final-mile behavior
8. `docs/versioning.md` ← version schema choices and same-day release logic
9. `docs/migrating-backend-date-releases.md` ← practical backend-style migration path
10. `docs/tool-wrap.md` ← why framework-invoked release tools are reserved
11. `docs/standards.md` ← local TS coding standards for this repo
12. `src/core/orchestration/finalize-run.ts` ← the shared run loop
13. `src/core/orchestration/phase-runner.ts` ← the plugin boundary

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
