# Example Configs

These examples show common adoption paths for Relay.

They are intentionally neutral and use placeholder names such as `Example Web
App`, `Example Service`, and `@example/component-library`.

## How to inspect an example

```bash
relay inspect-config --config examples/github-release-assets.yml
```

`inspect-config` shows:

```text
versioning  -> how version/tag identity is resolved
phase_plan  -> which plugin hooks will run and in what order
```

## Examples

### `plugins/`

Use when you want a copyable external plugin layout instead of only config
examples.

```text
plugin-manifest.json
  +
@ashwch/relay/plugin-sdk handler
  ↓
small working external plugin example
```

Start with:

- `examples/plugins/README.md`
- `examples/plugins/example-enricher/` — metadata enricher (one hook: enrich)
- `examples/plugins/example-notifier/` — notifier (two hooks: render + notify)
- `examples/plugins/example-verifier/` — artifact publisher (one hook: verify)

Then pair it with:

- `docs/plugin-authoring.md`

### `github-release-assets.yml`

Use when a repo needs to verify required GitHub Release assets before
notification.

```text
GitHub Release
  ↓
verify web-app.zip + checksums.txt exist
  ↓
enrich PRs from release body
  ↓
send Slack notification
```

### `npm-package-visibility.yml`

Use when a package publish happens before finalization and the framework should
verify package visibility in an npm registry.

```text
GitHub Release
  ↓
verify @example/component-library is visible
  ↓
enrich PR metadata
  ↓
send Slack notification
```

### `pr-metadata-enrichment.yml`

Use when the main value is adding PR context to the normalized release document
before notification.

```text
release body + GitHub commit association
  ↓
pull_requests[] in normalized release JSON
  ↓
notifier sees richer context
```

### `semantic-release-observe.yml`

Use when semantic-release already owns tag and GitHub Release creation.

```text
semantic-release created release
  ↓
relay observes + verifies it
  ↓
shared artifact/enrich/notify behavior
```

## Real-run secrets

Most examples use Slack and GitHub. A real run usually needs:

```bash
GITHUB_TOKEN=your-token \
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
relay finalize --config examples/pr-metadata-enrichment.yml ...
```

The config stores secret **names**, not secret values.

## Quick local experiment with the example plugin

Add this to a local config:

```yaml
metadata_enrichers:
  - plugin: path:./examples/plugins/example-enricher

plugin_allowlist:
  - path:./examples/plugins/example-enricher
```

Then inspect the planned hook surface:

```bash
relay inspect-config --config your-config.yml
```

Look for:

```text
phase_plan[].plugin
phase_plan[].hooks
```
