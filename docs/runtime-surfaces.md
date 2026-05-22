# Runtime Surfaces Guide

This file explains the small runtime entrypoints and shared constants in plain language.

## Why this guide exists

A framework like this has multiple ways to be invoked:

```text
CLI
→ local debugging
→ CI direct invocation

GitHub Action
→ action wrapper for GitHub-hosted runs

Reusable workflow
→ low-friction GitHub consumption surface
```

All three should feel like different doors into the **same room**, not three different implementations.

That is why we keep the runtime surfaces thin.

## The key idea

```text
many entrypoints
        ↓
one shared orchestration core
```

If that rule stays true, then:

- bug fixes land once
- tests stay relevant across surfaces
- docs stay simpler
- CI migrations are safer

## The small shared constants

File:

- `src/core/constants.ts`

This file exists to prevent silent drift in values that show up across runtime entrypoints.

Today it holds things like:

- default config path
- plugin manifest API version string
- normalized release schema version string

Why centralize those?

Because without one shared home, the same string tends to get copied into:

- CLI help text
- action wrapper defaults
- provider output
- schema checks

and then eventually one copy goes stale.

## The CLI surface

File:

- `src/cli/main.ts`

The CLI is the most direct surface.

It is useful for:

- local testing
- CI experimentation
- migration work
- debugging normalized release output

### Example: inspect config

```bash
release-framework inspect-config --config .github/release-framework.yml
```

`inspect-config` now shows two especially useful planning sections:

```text
versioning
  -> source type, tag template, counter behavior

phase_plan
  -> normalize/profile/tool/release-record/artifact/enrich/notify hooks
```

Use this before wiring a repo into CI so reviewers can see which plugins will
actually run.

### Example: preview normalized release JSON

```bash
release-framework normalize \
  --config .github/release-framework.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

### Example: preview the Slack payload without sending

```text
normalize --dry-run
        ↓
write normalized release JSON
        ↓
render-notification
        ↓
print payload, no webhook send
```

```bash
release-framework normalize \
  --config .github/release-framework.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run \
  --output-json /tmp/release-framework-normalized.json

release-framework render-notification \
  --config .github/release-framework.yml \
  --release-json /tmp/release-framework-normalized.json
```

For the full final-mile phase model, read:

- `docs/finalize-phases-and-notifications.md`

## The GitHub Action surface

Files:

- `actions/release-finalize/action.yml`
- `src/actions/release-finalize.ts`

The action wrapper should stay thin.

Its job is only:

```text
read action inputs
→ call the shared finalize code
→ publish action outputs
```

That is important because action wrappers are very easy places for logic drift to sneak in.

If this file starts making business decisions, the project becomes harder to trust.

## The reusable workflow surface

File:

- `.github/workflows/release-finalize.yml`

This is the easiest GitHub-native adoption path.

Instead of copying release YAML into every repository, a consumer repo can do this:

```yaml
jobs:
  release:
    uses: your-org/release-framework/.github/workflows/release-finalize.yml@v1
    with:
      config_path: .github/release-framework.yml
    secrets: inherit
```

That keeps caller repos small and keeps framework behavior centralized.

## Visual relationship between the surfaces

```text
CLI ----------------------┐
                          │
GitHub Action ------------┼──> shared finalize core
                          │
Reusable workflow --------┘
```

## The shared runtime maps

Files:

- `src/core/types/runtime.ts`
- `src/core/types/json.ts`

These types help us describe runtime boundaries clearly.

### `EnvMap`
Use when a function receives process-like environment variables.

### `RuntimeArgs`
Use when a function receives command or runtime arguments that are still
loosely shaped.

### `StringMap`
Use for simple string bags like secrets or files.

### `UnknownMap`
Use when a boundary is intentionally flexible but still deserves a named type.

Why do these matter?

Because this codebase spends a lot of time moving data across boundaries.

Named boundary types make it easier to see whether a function is dealing with:

- trusted internal data
- serialized external data
- still-flexible runtime data

## Rule of thumb for future work

If you add a new runtime surface, it should follow this shape:

```text
decode entrypoint-specific input
→ map it into existing shared types
→ call shared orchestration
→ encode entrypoint-specific output
```

If it starts doing more than that, pause and ask whether the new behavior
really belongs in core instead.

## Files to read next

1. `src/core/constants.ts`
2. `src/cli/main.ts`
3. `src/actions/release-finalize.ts`
4. `.github/workflows/release-finalize.yml`
5. `src/core/types/runtime.ts`
6. `src/core/orchestration/finalize-run.ts`
