# Contributing

Thank you for helping improve `release-framework`.

This repository is currently private, but the contribution rules are written as
if the project may become public later. The goal is to make the release contract
easy to audit before it is widely reused.

## First principles

```text
small explicit contract
        ↓
one normalized release document
        ↓
one finalization flow
        ↓
pluggable CI / tool / notification behavior
```

A good contribution should make that contract clearer, safer, or easier to
adopt.

## Development setup

```bash
npm ci
```

If your local shell has npm resolution issues, this repo has also been validated
with:

```bash
pnpm dlx npm@10 <command>
```

## Local quality gates

Run these before asking for review:

```bash
pnpm dlx npm@10 run lint
pnpm dlx npm@10 run typecheck
pnpm dlx npm@10 test
pnpm dlx npm@10 run build
pnpm dlx madge --extensions ts --circular src
```

When changing tests or test helpers, also check test imports:

```bash
pnpm dlx madge --extensions ts --circular src tests
```

## Coding standards

Read:

- `docs/standards.md`
- `docs/types.md`
- `docs/plugins.md`
- `docs/finalize-phases-and-notifications.md`

The short version:

- keep imports top-level and acyclic
- prefer named interfaces and shared runtime/JSON types
- avoid hidden side effects
- keep plugin boundaries explicit
- do not leak secret values into output JSON
- keep CLI/action wrappers thin; put behavior in shared core
- document why a layer exists, not only what it does

## Plugin changes

Plugins communicate through the normalized release document.

```text
plugin hook
  receives request envelope
  returns merge patch + outputs
  does not replace the whole release document
```

When adding or changing a plugin:

1. update its manifest
2. update tests for render/dry-run/real behavior where relevant
3. update docs with config examples
4. keep side-effect hooks explicit
5. fail closed when a required input is missing

## Documentation expectations

Every non-trivial behavior should have a first-principles explanation.

Prefer visual snippets like:

```text
input
  ↓
shared contract
  ↓
side effect
  ↓
result JSON
```

Good docs help future adopters understand why the framework exists instead of
copying one repository's release workflow blindly.
