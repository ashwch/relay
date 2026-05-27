# Validate Plugin Guide

This guide explains the `validate-plugin` command in simple language.

The short version is:

```text
before wiring a plugin into a real release flow
validate the plugin by itself first
```

Why this command exists:

```text
manifest mistakes are different from config mistakes
config mistakes are different from runtime mistakes
runtime mistakes are different from response-contract mistakes
```

A good author workflow should help you separate those quickly.

---

## First-principles mental model

`validate-plugin` is a fast local author loop.

Visual model:

```text
plugin ref
   ↓
load manifest
   ↓
validate plugin config
   ↓
build one run plan per built-in sample, fixture, or matched directory fixture
   ↓
optionally run dry-run hook execution
   ↓
validate response contract
   ↓
one clear result for the author
```

This is intentionally smaller than a full release run.

```text
validate-plugin -> validate one plugin directly
inspect-config  -> inspect plugin selection inside repo config
finalize        -> run the whole shared release flow
```

---

## Basic usage

Validate the checked-in example plugin:

```bash
relay validate-plugin path:./examples/plugins/example-enricher
```

That command does this:

```text
resolve plugin ref
→ load plugin manifest
→ validate manifest/runtime contract
→ validate plugin config
→ run dry-run hook execution
→ validate returned PluginResponse
```

`plugin ref` here can be built-in, `path:`, `npm:`, or `git:`.
For `git:` refs, Relay resolves the ref by cloning/fetching the plugin repo
before manifest validation can happen.

---

## The most useful command variants

### Static checks only

Use this when you want to confirm the manifest/config side before running the
plugin code.

```bash
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --no-exec
```

Mental model:

```text
manifest + config validation only
no hook execution
```

Important nuance for `git:` refs:

```text
--no-exec skips hook execution
it does not skip git clone/fetch
```

Why?
Because Relay still needs the local checkout in order to read
`plugin-manifest.json`.

### One hook only

Use this when a plugin declares multiple hooks and you want to focus on one.

```bash
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --hook enrich
```

### Validate against a richer request fixture

Use this when the built-in sample request is too small and you want a more
realistic hook input.

Important selection rule:

```text
--hook provided               -> validate that hook
--request-json provided only  -> validate the fixture's hook
neither provided              -> validate all declared hooks
```

Visual model:

```text
single-hook plugin
  ↓
built-in sample request is usually enough

multi-hook plugin
  ↓
request fixture becomes much more important
  ↓
because each hook usually wants a different request shape
```

Why prefer the fixture hook automatically?

```text
request fixtures are usually shaped for one concrete hook
        ↓
reusing that same fixture for unrelated hooks would be misleading
```

```bash
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --request-json examples/plugins/requests/enrich.request.json
```

You can also pass more than one fixture when a plugin has more than one hook:

```bash
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json examples/plugins/requests/render.request.json \
                 examples/plugins/requests/notify.request.json
```

Or point at a directory of `<hook>.request.json` fixtures:

```bash
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json-dir examples/plugins/requests
```

The checked-in `normalize.request.json` fixture now also works for provider
plugins because its `config` field uses full release-config shape, not `{}`.

This is especially useful when you want to control:

- the release document shape
- runtime args/env/files
- secret names
- workspace root
- the exact hook under test

For example, a notifier usually wants different fixtures for `render` and
`notify` because those hooks answer different questions:

```text
render -> what should the message look like?
notify -> what should happen at delivery time?
```

### Machine-readable output

Use this for tools, scripts, or CI wrappers.

```bash
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --json
```

### Validate plugin-local config explicitly

Use this when your plugin expects config fields and you want to validate them as
part of the author loop.

```bash
printf '{"summary_label":"Example enricher summary"}\n' >/tmp/example-plugin-config.json

relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --plugin-config-json /tmp/example-plugin-config.json
```

Important rule:

```text
--plugin-config-json expects one JSON object file
not a relay YAML config file
```

Good mental model:

```text
plugin-manifest.json -> declares the plugin contract
config.schema.json   -> declares the plugin config contract
plugin-config-json   -> one concrete config object to validate against that contract
request-json         -> one fuller hook input object to validate against the runtime contract
```

When a config file is provided explicitly, the command will report it back as:

```text
config_source=/absolute/path/to/your-plugin-config.json
```

That makes it easier to see exactly which config object was validated.

---

## What `validate-plugin` is actually checking

Think in two layers.

### Layer 1: static contract checks

```text
plugin ref resolves
manifest loads
hooks are declared
config schema path stays inside plugin root
plugin config matches config schema
```

### Layer 2: execution checks

```text
sample request is built
or request fixture is loaded
hook runs in dry-run mode
stdout is valid JSON
response shape is valid
response is JSON-safe
response size is bounded
```

That split is useful because it tells the author *which class of problem* they
are dealing with.

Why this matters even more now that the SDK exists:

```text
plugin-sdk helps authors speak the contract correctly
validate-plugin proves the plugin still behaves correctly inside the framework model
```

Those are related jobs, but not the same job.

---

## Provider plugins are special

There is one nuance worth knowing.

For provider plugins:

```text
request.config -> full release-config-shaped object
```

For most other plugins:

```text
request.config -> plugin-local config object
```

Why?

Because a provider's job is to translate incoming release context into the
shared normalized release document. Its config boundary is naturally broader.

So when you validate a provider plugin, the framework uses a sample full release
config shape by default.

For other plugin types, the framework assumes plugin-local config unless you
provide one explicitly.

---

## Request fixtures

Visual model:

```text
built-in sample request -> fastest happy-path validation
request fixture JSON    -> richer, more realistic hook input
```

Why keep both?

```text
authors need a zero-setup path first
        ↓
but they also need a realistic path before wiring into CI
```


Sample request fixtures now live here:

- `examples/plugins/requests/README.md`
- `examples/plugins/requests/*.request.json`

Why keep them checked in?

```text
plugin authors need copyable realistic hook inputs
without reverse-engineering the request shape from source code
```

Good mental model:

```text
--plugin-config-json -> change config only
--request-json       -> change fuller hook input
```

Important note:

```text
--request-json already includes config
so do not combine it with --plugin-config-json
```

And if you provide both `--hook` and `--request-json`, they should agree.
For example, a `render.request.json` fixture should normally be used with the
`render` hook, not `notify`.

If you pass more than one request fixture, omit `--hook` and let each fixture
validate its own declared hook.

If you use `--request-json-dir`, the command looks for:

```text
<hook>.request.json
```

for each declared hook, or for the one hook you named with `--hook`.

Important directory-mode rule:

```text
matching fixtures found   -> validate those hooks
zero matching fixtures    -> fail clearly
extra unrelated files     -> ignore them
```

Directory mode is intentionally a partial-match flow, not an all-hooks-required flow.
That keeps it useful while authors are still building fixtures incrementally.

Why fail instead of guessing?

```text
author asked for one hook
fixture describes another hook
        ↓
silent guessing would make the validation result harder to trust
```

## The checked-in example plugin workflow

The example plugin in this repo is:

```text
examples/plugins/example-enricher/
```

Recommended reading order:

1. `examples/plugins/README.md`
2. `examples/plugins/example-enricher/plugin-manifest.json`
3. `examples/plugins/example-enricher/config.schema.json`
4. `examples/plugins/example-enricher/index.mjs`
5. `examples/plugins/example-enricher/config.example.yml`

Recommended command order:

```bash
# 1. validate the plugin directly
relay validate-plugin path:./examples/plugins/example-enricher

# 2. validate it against a richer enrich request fixture
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --request-json examples/plugins/requests/enrich.request.json

# 3. inspect how a repo config would select it
relay inspect-config \
  --config examples/plugins/example-enricher/config.example.yml

# 4. run the full shared dry-run flow
relay finalize \
  --config examples/plugins/example-enricher/config.example.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

Mental model:

```text
validate-plugin -> plugin by itself
inspect-config  -> plugin selection plan
finalize        -> plugin inside full shared flow
```

---

## How to interpret failures

### Manifest/load error

Examples:

```text
unknown built-in plugin
plugin is not allowlisted
plugin-manifest.json missing
```

Usually means:

```text
fix plugin ref
or fix allowlist
or fix plugin layout
```

Common recipe:

```text
symptom:
  plugin does not even start validation

first checks:
  - is the ref spelled correctly?
  - is the ref in plugin_allowlist?
  - does plugin-manifest.json exist where the ref points?
```

### Config validation error

Examples:

```text
schema=/absolute/path/to/config.schema.json
/summary_label must be string
config_schema must stay inside plugin root
```

Typical next action:

```text
edit the plugin config JSON object
or fix config.schema.json
or fix the manifest config_schema path
```

Useful clues usually include:

```text
config_source=...
schema=...
```

Common recipe:

```text
symptom:
  plugin-config validation fails before hook execution

first checks:
  - did you pass the right JSON file to --plugin-config-json?
  - does config.schema.json expect the field/type you provided?
  - is manifest config_schema relative to the plugin root?
  - if config.schema.json is a symlink, does its real target still stay inside the plugin root?
```

Usually means:

```text
fix plugin config JSON
or fix config.schema.json path
```

### Hook/runtime error

Examples:

```text
declared_hooks=enrich
requested hook notify is not declared by the plugin
external plugin timed out
external plugin failed to start
```

Typical next action:

```text
choose one of the declared hooks
or omit --hook to validate all declared hooks
```

Common recipe:

```text
symptom:
  validation reaches execution, but the hook never succeeds

first checks:
  - does manifest.hooks include the hook you asked for?
  - does entrypoint.handler exist?
  - if entrypoint.handler is a symlink, does its real target still stay inside the plugin root?
  - does the process exit cleanly when run locally?
  - is the plugin hanging waiting for stdin or never writing stdout?
```

Usually means:

```text
fix manifest hooks
or fix handler startup/runtime behavior
```

### Response contract error

Examples:

```text
cause=external plugin ... returned invalid JSON
returned invalid JSON
release_patch must be an object
outputs must be an object
response exceeds max size
```

Typical next action:

```text
keep stdout machine-readable
move debug text to stderr
return one small JSON object only
```

Helpful rule:

```text
if the command says "dry-run hook execution" failed,
read the cause=... line first
```

Common recipe:

```text
symptom:
  plugin process ran, but contract validation failed afterward

first checks:
  - is stdout JSON only?
  - are debug messages going to stderr instead?
  - is release_patch an object?
  - is outputs an object?
  - are you returning one response object, not a stream of objects?
```

Usually means:

```text
fix stdout response shape
keep stdout machine-readable
move debug text to stderr
keep patch/output small
```

---

## What the default human output is trying to tell you

The default terminal output is intentionally short and phase-like.

Typical shape:

```text
Plugin: path:./examples/plugins/example-enricher
Name: example-enricher
Type: metadata_enricher
Hooks: enrich
Config schema: config.schema.json

Static checks:
  ✔ plugin ref resolved (...)
  ✔ manifest loaded (...)
  ✔ plugin config validated (...)

Execution checks:
  ✔ dry-run hook executed (hook=enrich; response_status=ok)
```

Helpful detail fields you may now see include:

```text
schema=...
config_kind=plugin-config
config_source=...
request_source=...
render=examples/plugins/requests/render.request.json
notify=examples/plugins/requests/notify.request.json
```

How to read that:

```text
Plugin section      -> what was validated
Static checks       -> load/manifest/config layer passed
Execution checks    -> dry-run hook layer passed
request_source=...  -> which fixture file shaped the request, if any
```

If you want to feed the result into another tool, use:

```bash
relay validate-plugin path:./examples/plugins/example-enricher --json
```

## Request fixture mistakes

When using `--request-json`, a different class of authoring mistake becomes
possible: the fixture itself may be malformed.

Common recipe:

```text
symptom:
  validate-plugin fails before the plugin even starts
  and the error mentions request fixture fields

first checks:
  - does the fixture include hook?
  - does it include dry_run?
  - does it include release?
  - does inputs contain env/args/files objects?
  - are env/files/secrets values strings?
  - is release either null or a valid normalized release document?
```

Good rule of thumb:

```text
request fixture problems are author-input problems
plugin runtime problems are handler-code problems
```

For multi-hook plugins with no fixture, the command now also prints suggested
sample fixture paths for each declared hook.
That gives authors a quick "start here" path without reading the source first.

Typical shape:

```text
sample request fixtures available
  render=examples/plugins/requests/render.request.json
  notify=examples/plugins/requests/notify.request.json
```

## Important stdout/stderr rule

If you are using `@ashwch/relay/plugin-sdk`, this rule still matters.
The SDK helps you honor it, but it does not change the boundary itself.


This is one of the most important author rules for subprocess plugins:

```text
stdout -> PluginResponse JSON only
stderr -> debug text
```

Why?

Because the framework parses stdout as the plugin response contract.
If a plugin mixes banners, debug logs, or extra text into stdout, validation
will fail even if the rest of the plugin logic is correct.

---

## When to use `validate-plugin` vs other commands

### Use `validate-plugin` when:

Good command progression for a new multi-hook plugin:

```bash
# 1. confirm manifest + config shape first
relay validate-plugin path:./plugins/my-notifier --no-exec

# 2. validate one hook-shaped fixture at a time
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/render.request.json

relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/notify.request.json

# 3. or validate both hook-shaped fixtures in one run
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/render.request.json \
                 examples/plugins/requests/notify.request.json

# 4. or let a fixture directory auto-match by hook name
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json-dir examples/plugins/requests
```

Why this order helps:

```text
static checks first
        ↓
one concrete hook at a time
        ↓
clearer failures and less fixture confusion
```

### Use `validate-plugin` when:

- you are writing a plugin
- you are debugging manifest/config/runtime issues
- you want fast feedback without a whole release flow

### Use `inspect-config` when:

- you want to know which plugin a repo config will select
- you want to inspect planned phase hooks

### Use `normalize` when:

- you want to inspect provider/profile baseline release state

### Use `finalize --dry-run` when:

- you want to see the plugin inside the whole shared flow
- you want artifact/enrich/notify phases to actually run

---

## Current limitations

Today:

- external plugins run through a subprocess boundary
- GitHub-sourced plugin fetching is not implemented yet
- JavaScript/TypeScript authors can use `@ashwch/relay/plugin-sdk`, but fixture validation still targets the raw JSON contract

So the current design goal is:

```text
make plugin authoring clear
make failures early
make the contract explicit
```

---

## Files to read next

1. `docs/plugin-authoring.md`
2. `docs/plugins.md`
3. `src/cli/commands/validate-plugin.ts`
4. `src/core/plugins/config-validation.ts`
5. `src/core/plugins/response-validation.ts`
6. `src/core/plugins/subprocess-runner.ts`
7. `examples/plugins/README.md`
