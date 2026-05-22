# Local Standards

This repository is TypeScript-first, so some Python- or Django-specific rules do not apply directly here.

Still, the spirit of those rules does apply.

## First-principles translation

```text
Python rule: avoid loose dicts
TypeScript translation: prefer named interfaces and shared JSON/runtime types
```

```text
Python rule: avoid dynamic magic
TypeScript translation: keep plugin/runtime boundaries explicit and typed
```

```text
Python rule: avoid hidden side effects
TypeScript translation: keep action, CLI, and core orchestration on one shared codepath
```

## Standards we enforce here

### 1. One shared codepath

The CLI, the reusable workflow, and the GitHub Action should all converge on the same core logic.

Why:

```text
fewer codepaths
→ fewer drift bugs
→ easier reviews
→ easier tests
```

### 2. Name boundary types

At file, CLI, plugin, and API boundaries, do not repeat loose structural types when a named shared type would make intent clearer.

Examples used in this repo:

- `JsonObject`
- `JsonValue`
- `EnvMap`
- `RuntimeArgs`

### 3. Fail closed

If release identity is ambiguous, a required hook is missing, or the GitHub release state does not match expectations, fail instead of guessing.

### 4. Avoid hidden plugin behavior

Plugin hooks should be explicit.

Bad:

```text
missing hook silently noops
```

Good:

```text
missing hook fails clearly
```

### 5. Keep orchestration readable

The core finalize path should remain understandable as a short sequence:

```text
normalize
→ plan
→ ensure release record
→ notify
→ summarize
```

### 6. Prefer small helpers over clever abstractions

This repo is infrastructure logic, not product UI.

Use small helpers with obvious names instead of large generic frameworks.

### 7. Document why, not just what

Every major layer should explain:

- why it exists
- what contract it protects
- what kinds of bugs it is trying to prevent

### 8. Keep imports top-level and acyclic

Do not add local runtime imports inside functions to work around dependency design.
If a dependency cycle appears, split shared types/constants into a lower-level module
instead of hiding the import.

### 9. Keep secrets at the runtime boundary

Plugins should receive secrets through the plugin request `secrets` map. Avoid
direct environment-variable reads inside plugin implementation code so CLI,
action, tests, and future external runtimes all enforce the same boundary.

### 10. Prefer shared map types over ad-hoc records

Use `JsonObject`, `UnknownMap`, `StringMap`, and named interfaces instead of
repeating `Record<string, unknown>` or mixed-value maps at boundaries.

### 11. Name operational limits

If a limit matters operationally, give it a named constant. Examples include
response-body truncation limits, retry counts, and API page sizes.

### 12. Do not repeat large test fixtures

Large release documents and config objects should live in helpers or fixture
files. Tests should override the smallest relevant piece so the intent of each
case stays visible.

## Commands we expect to stay green

```bash
npm run lint
npm run typecheck
npm test
npm run build
pnpm dlx madge --extensions ts --circular src
```

## Non-applicable source-language rules

These are useful in other codebases, but not directly applicable in this repository:

- Ruff
- Django ORM reverse relation guidance
- framework-specific structured logging conventions from other stacks
- Python `TypedDict`

Their TypeScript equivalents are still encouraged here:

- explicit interfaces and shared types
- readable typed payloads
- small auditable integration boundaries
