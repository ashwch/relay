# Coding Standards

This repository is TypeScript-first, with explicit typed boundaries at every
plugin, CLI, and runtime surface.

## First-principles foundation

```text
Rule: avoid loose structural types at boundaries
Translation: prefer named interfaces and shared JSON/runtime types
```

```text
Rule: avoid hidden runtime magic
Translation: keep plugin/runtime boundaries explicit and typed
```

```text
Rule: avoid hidden side effects
Translation: keep action, CLI, and core orchestration on one shared codepath
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

### 13. Document trust-boundary checks in simple language

If a file validates plugin input, plugin output, config, or release invariants,
add comments that explain the check in first-principles language.

Good pattern:

```text
what boundary is being protected
→ why the check exists
→ what kind of bad state it prevents
```

Why this matters here:

This repository spends a lot of time turning flexible runtime input into one
trusted release document. Future readers should be able to understand those
checks without reverse-engineering the whole code path.

### 14. Do not use type assertions to skip validation

Avoid `as SomeType` when the value came from JSON, the filesystem, stdin,
stdout, or another runtime boundary.

Preferred pattern:

```text
parse unknown input
→ validate with a small type guard or schema
→ only then treat it as the named type
```

Why:

```text
type assertions make unsafe runtime data look trusted too early
```

### 15. Keep catch blocks narrow and actionable

Catch only the smallest operation that can realistically fail.
If parse, validation, and execution can fail for different reasons, give them
separate error messages.

Why:

```text
smaller catch blocks
→ clearer failures
→ easier tests
→ less accidental error swallowing
```

### 16. Share test harnesses before repeating setup

If several tests need the same stdin/stdout buffers, sample requests, or plugin
runtime harness, extract a tiny helper before the fixture setup starts to sprawl.

Why:

```text
small shared test harnesses
→ less fixture drift
→ clearer per-test intent
```

### 17. Rebuild before testing built CLI behavior

If you are validating `dist/cli/main.js`, run a fresh build first.
Do not assume `dist/` reflects the latest source edits.

Why:

```text
stale dist output
→ misleading smoke-test results
→ confusion about whether source or build is wrong
```

### 18. Prefer one concrete fixture per concrete hook

For author tooling such as `validate-plugin`, if a request fixture declares one
hook, treat that fixture as belonging to that hook.
Do not silently reuse a render-shaped fixture for notify, or vice versa.

Why:

```text
one fixture
→ one hook mental model
→ fewer misleading validations
→ clearer failure messages
```

## Commands we expect to stay green

```bash
npm run lint
npm run typecheck
npm test
npm run build
pnpm dlx madge --extensions ts --circular src
```
