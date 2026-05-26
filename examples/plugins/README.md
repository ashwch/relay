# Example Plugins

These examples show the smallest useful external plugin layouts.

Why keep them tiny?

```text
plugin author should learn the contract first
then add domain-specific behavior second
```

## `example-enricher/`

This directory is a minimal external metadata enricher.

Layout:

```text
examples/plugins/example-enricher/
  plugin-manifest.json
  config.schema.json
  index.mjs
  config.example.yml
```

Mental model:

```text
PluginRequest JSON on stdin
        ↓
runPluginCli(...)
        ↓
small enrich step
        ↓
PluginResponse JSON on stdout
```

## How to wire it into config

You can either copy the relevant block into an existing config, or start from:

- `examples/plugins/example-enricher/config.example.yml`

If your config file lives inside `examples/plugins/example-enricher/`, the
checked-in example uses this relative block:

```text
path: refs are resolved relative to the config file location
```

```yaml
metadata_enrichers:
  - plugin: path:./

plugin_allowlist:
  - path:./
```

If your config file lives at the repo root instead, use:

```yaml
metadata_enrichers:
  - plugin: path:./examples/plugins/example-enricher

plugin_allowlist:
  - path:./examples/plugins/example-enricher
```

## What it does

The example enricher is intentionally boring.

It patches this shape into the normalized release document:

```text
extensions.example_enricher
```

and returns a small structured summary in:

```text
outputs.summary
```

That makes it easy to see the two most important plugin response surfaces:

```text
release_patch -> shared release state
outputs       -> extra hook-local output
```

It also now demonstrates one more important contract surface:

```text
config.schema.json -> validate plugin config before hook execution
```

And all three example plugins now use the stable JavaScript/TypeScript SDK:

```text
@ashwch/relay/plugin-sdk
```

Why switch the examples to the SDK?

```text
examples should teach the recommended author path
        ↓
recommended author path should avoid repeated stdin/stdout boilerplate
        ↓
future readers should learn domain behavior first, not stream plumbing first
```

## Quick local experiment

Useful reading order for the enricher example:

```text
plugin-manifest.json -> what core is allowed to call
config.schema.json   -> what config is allowed to look like
index.mjs            -> what the plugin actually does
config.example.yml   -> how a repo wires the plugin in
```

Validate the plugin by itself first:

```bash
relay validate-plugin path:./examples/plugins/example-enricher
```

Validate the same plugin against a richer enrich request fixture:

```bash
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --request-json examples/plugins/requests/enrich.request.json
```

Validate the example plugin's config explicitly:

```bash
printf '{"summary_label":"Example enricher summary"}\n' >/tmp/example-plugin-config.json
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --plugin-config-json /tmp/example-plugin-config.json
```

Then inspect the example config:

```bash
relay inspect-config \
  --config examples/plugins/example-enricher/config.example.yml
```

Preview the base normalized release document:

```bash
relay normalize \
  --config examples/plugins/example-enricher/config.example.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

Then run the full dry-run finalize flow so the example enricher actually
executes:

```bash
relay finalize \
  --config examples/plugins/example-enricher/config.example.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

Why these commands help:

```text
validate-plugin -> fastest manifest/config/runtime contract check
inspect-config  -> confirms the plugin is selected and the enrich hook is planned
normalize       -> shows provider/profile baseline release state
finalize        -> runs the enrich phase and shows the plugin in the shared flow
```

Important distinction:

```text
normalize does not run metadata enrichers
finalize does
```

When experimenting locally, remember one important subprocess rule:

```text
stdout should contain PluginResponse JSON only
stderr is the safe place for debug text
```

## How to reason about it

If you are new to plugin authoring, read these in order:

1. `docs/plugin-authoring.md`
2. `docs/validate-plugin.md`
3. `docs/plugins.md`
4. `examples/plugins/requests/README.md`
5. `examples/plugins/example-enricher/plugin-manifest.json`
6. `examples/plugins/example-enricher/index.mjs`
7. `examples/plugins/requests/enrich.request.json`

## `example-notifier/`

This directory is a minimal external notifier that demonstrates both the
`render` and `notify` hooks.

Layout:

```text
examples/plugins/example-notifier/
  plugin-manifest.json
  index.mjs
  config.example.yml
```

Mental model:

```text
render hook -> build a notification payload (no side effects)
notify hook -> simulate delivery (noop when dry_run=true)
```

The notifier type is the only plugin type with two hooks: `render` (formatting)
and `notify` (delivery). This split matters because it lets you preview messages
without sending them.

### What it does

When `hook=render`:
- Builds a Slack-compatible notification payload from the release document
- Returns the payload in `outputs.payload` (no HTTP call)
- Safe in dry-run mode

When `hook=notify`:
- Checks if `SLACK_WEBHOOK_URL` is configured in secrets
- Returns `noop` when `dry_run=true`
- Would deliver when `dry_run=false` (simulated here)

### Quick local experiment

Useful reading order for the notifier example:

```text
plugin-manifest.json -> declares both render and notify hooks
index.mjs            -> shows formatting vs delivery split
config.example.yml   -> shows how the repo selects the notifier
```

```bash
# validate both hooks with built-in sample data
relay validate-plugin path:./examples/plugins/example-notifier

# validate the render hook with a realistic fixture
# (the fixture hook auto-selects render)
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json examples/plugins/requests/render.request.json

# validate the notify hook with a secret fixture
# (the fixture hook auto-selects notify)
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json examples/plugins/requests/notify.request.json

# or validate both hook-shaped fixtures in one run
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json examples/plugins/requests/render.request.json \
                 examples/plugins/requests/notify.request.json

# or let the fixture directory auto-match render + notify by hook name
relay validate-plugin \
  path:./examples/plugins/example-notifier \
  --request-json-dir examples/plugins/requests

# inspect how a repo config selects the notifier
relay inspect-config \
  --config examples/plugins/example-notifier/config.example.yml
```

Why show two separate fixture commands here?

```text
render and notify are different hooks
        ↓
each hook usually wants a different request shape
        ↓
one fixture per hook keeps the validation result easier to trust
```

## `example-verifier/`

This directory is a minimal external artifact publisher that demonstrates the
`verify` hook.

Layout:

```text
examples/plugins/example-verifier/
  plugin-manifest.json
  config.schema.json
  index.mjs
  config.example.yml
```

Mental model:

```text
verify hook -> compare expected assets against release.artifacts
```

The artifact_publisher type supports two hooks: `publish` (side effects) and
`verify` (checks). The verifier example focuses on `verify` — it inspects the
release document without performing side effects.

### What it does

- Reads `expected_asset_names` from plugin config
- Compares against `release.artifacts` in the release document
- Returns `status: "ok"` when all expected assets are present
- Returns `status: "error"` with a descriptive `error_message` when assets are missing
- Patches verification results into `extensions.example_verifier`

### Quick local experiment

Useful reading order for the verifier example:

```text
plugin-manifest.json -> declares verify as the only hook
config.schema.json   -> defines expected_asset_names
index.mjs            -> compares expected assets to release.artifacts
config.example.yml   -> shows repo wiring
```

```bash
# validate with built-in sample data (no artifacts, expect error)
relay validate-plugin path:./examples/plugins/example-verifier

# validate against the verify request fixture (expect ok)
relay validate-plugin \
  path:./examples/plugins/example-verifier \
  --request-json examples/plugins/requests/verify.request.json

# validate with explicit plugin config
printf '{"expected_asset_names":["release-manifest.json","checksums.txt"]}\n' \
  >/tmp/verifier-config.json
relay validate-plugin \
  path:./examples/plugins/example-verifier \
  --plugin-config-json /tmp/verifier-config.json

# inspect how a repo config selects the verifier
relay inspect-config \
  --config examples/plugins/example-verifier/config.example.yml
```
