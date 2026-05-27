# Plugin Authoring Guide

This guide explains how to write a plugin for Relay in simple,
first-principles language.

The most important idea is:

```text
plugin author owns domain-specific behavior
framework owns the shared runtime contract
```

That means your plugin should focus on:

- the release fact you know how to compute
- the asset/package/check you know how to verify
- the notification you know how to render or send

And the framework will handle:

- loading the manifest
- deciding which hook is allowed to run
- building the request envelope
- validating the response
- merge-patching the shared release document

---

## Start with the mental model

A plugin is not "a random module the framework imports".

A plugin is a small contract with two parts:

```text
manifest
  -> what the plugin is allowed to do

runtime program/handler
  -> how the plugin actually does it
```

For external plugins, the runtime contract is intentionally tiny:

```text
PluginRequest JSON on stdin
        ↓
plugin code runs
        ↓
PluginResponse JSON on stdout
```

Visual flow:

```text
repo config selects plugin ref
        ↓
framework loads manifest
        ↓
framework checks hooks + compatibility + allowlist
        ↓
framework sends PluginRequest
        ↓
plugin returns PluginResponse
        ↓
framework validates + merge-patches result
```

---

## Step 1: choose the plugin type

The framework supports six plugin types:

```text
provider           -> where the release run came from
profile            -> what done means
release_tool       -> tool-specific release ownership
artifact_publisher -> publish/verify assets or packages
metadata_enricher  -> add extra context
notifier           -> render/send downstream notifications
```

Rule of thumb:

- if you describe CI input, write a **provider**
- if you define completion semantics, write a **profile**
- if you talk to an existing release tool, write a **release_tool**
- if you check or publish artifacts, write an **artifact_publisher**
- if you add context like PRs, write a **metadata_enricher**
- if you render or send messages, write a **notifier**

---

## Step 2: choose the hook

A plugin type does not get arbitrary hooks.

Current allowed hook mapping:

```text
provider           -> normalize
profile            -> plan
release_tool       -> observe / publish
artifact_publisher -> publish / verify
metadata_enricher  -> enrich
notifier           -> render / notify
```

Why be this explicit?

Because these two questions are different:

```text
What kind of plugin is this?
What runtime function may core actually call?
```

That is why manifests now have explicit `hooks`.

---

## Step 3: write `plugin-manifest.json`

A manifest is the plugin's contract card.

Minimal example for an external metadata enricher:

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

### What the most important fields mean

#### `type`
What kind of plugin this is.

#### `hooks`
The runtime hook names core may call.

#### `capabilities`
Human/business meaning.

Think of it like this:

```text
hooks        -> runtime permission
capabilities -> human intent
```

#### `entrypoint`
How to launch the plugin.

Current external styles:

```text
kind=module -> framework runs: node <handler>
kind=path   -> framework runs: <handler>
```

#### `framework_version_range`
Which framework versions this plugin expects.

#### `required_secrets` / `optional_secrets`
What explicit secret names the plugin may need.

#### `config_schema`
Optional relative path to a JSON schema for the plugin's resolved config.

Why add this?

Because bad plugin config should fail before the hook runs, not deep inside the
plugin implementation after the framework has already committed to a phase.

---

## Step 4: write the handler program

For JavaScript/TypeScript authors, the recommended entrypoint is now:

```text
@ashwch/relay/plugin-sdk
```

Why add a stable SDK?

```text
copy-pasted stdin boilerplate in every plugin
        ↓
slightly different local error handling in every plugin
        ↓
author confusion and avoidable stdout mistakes
```

The SDK gives authors one small shared path instead:

```text
runPluginCli(...)
  -> read stdin
  -> parse request JSON
  -> do a light request-shape check
  -> call your handler
  -> write one response JSON object to stdout
```

Minimal `index.mjs` example:

A real checked-in example also lives here:

- `examples/plugins/example-enricher/`
- `examples/plugins/example-enricher/config.example.yml`

```js
import { okResponse, runPluginCli } from "@ashwch/relay/plugin-sdk";

runPluginCli(async (request) => {
  return okResponse({
    extensions: {
      example_enricher: {
        saw_hook: request.hook,
        dry_run: request.dry_run
      }
    }
  });
});
```

That is enough to prove the contract.

The SDK keeps stdout machine-readable and removes repetitive stdin parsing, but the underlying contract is still the same JSON boundary.

Visual model:

```text
framework sends PluginRequest JSON
        ↓
runPluginCli(...) parses it
        ↓
your handler computes one focused result
        ↓
okResponse / noopResponse / errorResponse
        ↓
framework validates PluginResponse JSON
```

Why is the example so small?

Because plugin authoring gets much easier once you internalize the real shape:

```text
read request JSON
do one focused job
write response JSON
```

---

## Step 5: understand `PluginRequest`

The framework sends a request like this:

```text
plugin_api_version
hook
dry_run
plugin metadata
config
release
inputs
secrets
workspace
```

Useful mental model:

```text
request.config   -> this plugin's configured options
request.release  -> current shared release document
request.inputs   -> runtime inputs
request.secrets  -> explicit secret bag
request.workspace.root -> repo working directory
```

### Important boundary rules

For external plugins:

```text
request.inputs.env -> empty by default
request.secrets    -> explicit secret channel
process.env        -> minimal launch environment only
```

Why so strict?

Because we do not want external plugins to depend on ambient CI state or to
accidentally read unrelated secrets.

If a plugin needs something important, the preferred shape is:

```text
declare it
        ↓
configure it
        ↓
framework passes it explicitly
```

This is also why the SDK does a small request-shape check up front.
It is not trying to replace framework-side validation.
It is trying to fail early with a simple local message when stdin is obviously
wrong.

---

## Step 6: return a valid `PluginResponse`

Every plugin returns this logical shape:

```json
{
  "status": "ok",
  "release_patch": {},
  "outputs": {},
  "logs": []
}
```

### Fields

#### `status`
One of:

```text
ok
noop
error
```

#### `release_patch`
A merge patch, not a full replacement release document.

#### `outputs`
Extra structured output from the hook.

#### `logs`
Small structured log records.

### SDK response helpers

The SDK exposes three small helpers because most plugins only need three
response shapes:

```text
okResponse(...)    -> hook succeeded
noopResponse(...)  -> hook intentionally did nothing
errorResponse(...) -> hook failed clearly
```

Why add these helpers?

```text
same response envelope repeated everywhere
        ↓
more copy-paste
        ↓
more chances to get stdout shape wrong
```

The helpers keep the repeated envelope boring so plugin authors can focus on
business behavior.

---

## Why the response validator is strict

The framework validates plugin responses before merge-patching them back into
shared state.

Visual model:

```text
plugin stdout
    ↓
response schema validation
    ↓
JSON-safety validation
    ↓
size-limit validation
    ↓
merge patch
```

The validator rejects things like:

- invalid JSON
- missing required top-level fields
- non-object `release_patch`
- non-object `outputs`
- `NaN`
- circular references
- functions
- symbols
- oversized payloads

Why be so strict?

Because the normalized release document is the framework's shared source of
truth. If a plugin can leak JavaScript-only runtime values into that contract,
failures become harder to understand later.

---

## Keep the patch small

Good plugin response:

```json
{
  "status": "ok",
  "release_patch": {
    "extensions": {
      "example_enricher": {
        "pull_request_count": 4
      }
    }
  },
  "outputs": {},
  "logs": []
}
```

Bad plugin response mental model:

```text
rewrite the whole release document
hide large payloads in outputs
smuggle unrelated runtime data into shared state
```

Rule of thumb:

```text
patch only the fields your plugin truly owns
```

---

## Wire the plugin into repo config

Example config:

```yaml
metadata_enrichers:
  - plugin: path:./plugins/example-enricher

plugin_allowlist:
  - path:./plugins/example-enricher
```

Important path rule:

```text
path: plugin refs are resolved relative to the config file location
not relative to the repo root by magic
```

So these two configs mean different things:

```yaml
# config lives at repo root
plugin: path:./plugins/example-enricher
```

```yaml
# config lives inside plugins/example-enricher/
plugin: path:./
```

That rule is easy to miss, but it is important for keeping plugin loading
explicit and predictable.

Why the allowlist?

Because external plugin refs should always be explicit.
The framework should not discover arbitrary local code automatically.

---

## Validate before you wire it into a release flow

The fastest author loop is now:

```bash
relay validate-plugin path:./plugins/example-enricher
```

If you want a command-focused reference, read:

- `docs/validate-plugin.md`

Why this command matters:

```text
manifest errors fail early
config schema errors fail early
hook/runtime contract errors fail early
```

Useful variants:

```bash
# static checks only
relay validate-plugin path:./plugins/example-enricher --no-exec

# validate one declared hook
relay validate-plugin path:./plugins/example-enricher --hook enrich

# machine-readable result for tools/CI
relay validate-plugin path:./plugins/example-enricher --json

# validate plugin-local config from a JSON object file
relay validate-plugin \
  path:./plugins/example-enricher \
  --plugin-config-json /tmp/example-plugin-config.json

# validate a multi-hook plugin against more than one fixture in one run
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/render.request.json \
                 examples/plugins/requests/notify.request.json

# or point at a directory of <hook>.request.json fixtures
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json-dir examples/plugins/requests
```

Important note:

```text
--plugin-config-json expects one JSON object file
it is not a full relay YAML config file
```

And there is one important nuance:

```text
provider plugins -> validate full release-config-shaped request.config
most other plugins -> validate plugin-local request.config
```

For multi-hook plugins, a useful mental model is:

```text
one fixture
→ one hook
→ one request shape
```

Why mention that explicitly?

Because plugin authors should understand what surface they are validating.
A provider plugin is responsible for the whole incoming release context shape,
so its config boundary is naturally larger.

## Inspect before you run

Before a real finalize run, inspect the config:

```bash
relay inspect-config --config .github/relay.yml
```

Look especially at:

```text
phase_plan[].plugin
phase_plan[].hooks
```

This answers:

```text
Did the framework select the plugin I expected?
Which hook will actually run?
```

For the checked-in example plugin, this command should show an `enrich` phase
for `example-enricher`:

```bash
relay inspect-config \
  --config examples/plugins/example-enricher/config.example.yml
```

If you want to see the example plugin actually execute inside the shared release
flow, use either `validate-plugin` or a dry-run finalize flow.

Fast author-only loop:

```bash
relay validate-plugin path:./examples/plugins/example-enricher
```

Full framework loop:

```bash
relay finalize \
  --config examples/plugins/example-enricher/config.example.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

Why `finalize` instead of `normalize` here?

```text
normalize -> provider/profile/base release document only
finalize  -> full shared flow, including enrich/notify phases when configured
```

---

## Debugging checklist

### The SDK says stdin is not PluginRequest-shaped
This usually means you are testing the plugin with hand-written stdin that does
not match the framework envelope.

Mental model:

```text
runPluginCli protects the outer request shape
framework protects the full runtime contract
```

Best next step:

```bash
relay validate-plugin path:./plugins/example-enricher
```

That gives you a known-good request builder instead of hand-crafting stdin.


### The plugin does not load
Check:

- plugin ref starts with `path:` or `npm:`
- plugin ref is in `plugin_allowlist`
- `plugin-manifest.json` exists
- manifest `type` matches the place you configured it

### The plugin loads but does not run
Check:

- manifest `hooks` includes the hook core is trying to call
- external plugin `entrypoint.handler` exists
- handler stays inside the plugin root

### The plugin runs but fails validation
Check:

- stdout is valid JSON
- `release_patch` is an object
- `outputs` is an object
- response is small enough
- no `NaN`, functions, symbols, or circular references
- the plugin returned one JSON object, not extra banner text mixed into stdout

Best first command:

```bash
relay validate-plugin path:./plugins/example-enricher
```

Helpful rule of thumb:

```text
stdout -> machine-readable response only
stderr -> human/debug output
```

### The plugin needs secrets
Preferred shape:

```text
manifest declares secret name needs
        ↓
framework resolves secret
        ↓
plugin reads request.secrets
```

Avoid relying on ambient `process.env` for plugin business behavior.

---

## Current limits to remember

Today:

- external plugins run via subprocess
- GitHub-sourced plugin fetching is not implemented yet
- JavaScript/TypeScript authors can use `@ashwch/relay/plugin-sdk`, but the underlying contract is still plain stdin/stdout JSON

So for now, optimize for:

```text
small manifest
small handler
small patch
explicit contract
```

---

## Files to read next

If you want the smallest real example first, read:

1. `examples/plugins/README.md`
2. `examples/plugins/example-enricher/plugin-manifest.json`
3. `examples/plugins/example-enricher/index.mjs`

Then continue with the broader internals below.

## More files to read next

1. `docs/plugins.md`
2. `src/core/plugins/manifest.ts`
3. `src/core/plugins/loader.ts`
4. `src/core/plugins/config-validation.ts`   ← why plugin config fails early
5. `src/core/plugins/subprocess-runner.ts`   ← why external plugins run out-of-process
6. `src/core/plugins/response-validation.ts` ← why stdout JSON is validated so strictly
7. `src/core/orchestration/phase-runner.ts`
8. `schemas/plugin-manifest.schema.json`
9. `schemas/plugin-response.schema.json`
