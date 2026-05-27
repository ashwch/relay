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

### `version-package-json.yml`

Use when a package repo already stores the publishable version in
`package.json`.

```text
package.json version
  ↓
relay reads it directly
  ↓
tag/release identity stays aligned with npm
```

### `version-env.yml`

Use when an upstream CI system or release tool already decided the final
version and exposes it through an environment variable.

```text
CI export (for example RELEASE_VERSION)
  ↓
relay reads env
  ↓
finalize with that exact version
```

### `version-git-tag.yml`

Use when the current git tag is already the source of truth.

```text
git tag v1.2.3
  ↓
extract 1.2.3
  ↓
release/tag identity stays tag-driven
```

### `version-conventional-commits.yml`

Use when the repo already follows conventional commits and you want Relay to
infer the next semver bump from git history.

```text
latest reachable semver tag
  +
conventional commit messages since that tag
  ↓
next semver version
```

### `version-changesets.yml`

Use when the repo already uses Changesets and Relay should infer the next
semver bump from pending `.changeset/*.md` files.

```text
latest reachable semver tag
  +
pending changeset bump files
  ↓
next semver version
```

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

### `git-plugin-notifier.yml`

Use when the plugin source should stay in a Git repo and Relay should load it
from a `git:` ref directly.

```text
relay.yml names one git: plugin ref
  ↓
Relay clones/fetches that repo into its cache
  ↓
plugin-manifest.json is loaded from the configured subdirectory
  ↓
normal notifier execution continues
```

This is the example to read when you want to avoid:

```text
manual CI clone steps
or
publishing the plugin to npm before every consumer can use it
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

## Helpful git plugin commands

Replace the placeholder `acme/relay-plugins` ref with a real reachable repo
before running these commands.

```bash
# inspect the config surface after replacing the placeholder git: ref
relay inspect-config --config examples/git-plugin-notifier.yml

# static validation only
relay validate-plugin git:github.com/acme/relay-plugins//slack-notify@main --no-exec

# end-to-end validation
relay validate-plugin git:github.com/acme/relay-plugins//slack-notify@main
```

Important nuance:

```text
--no-exec skips hook execution
it does not skip git clone/fetch
```

Relay still needs the local checkout in order to read `plugin-manifest.json`.

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
