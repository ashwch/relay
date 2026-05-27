# Relay

Relay is a CI-agnostic release finalization framework.

It is designed for teams that use different build and release flows across repositories but still want one shared **last mile** for:

- GitHub Release creation or observation
- artifact/package verification
- metadata enrichment
- notifications

Relay does **not** replace your CI pipeline or your release tool. It standardizes what happens after a release is ready.

## What Relay does

Relay takes release state from a provider, resolves release behavior from a profile, and runs a shared finalization flow.

```text
provider -> normalize -> plan -> release record -> verify/publish -> enrich -> notify
```

## Core concepts

- **Provider**: where the release run came from (`builtin:github-actions`, `builtin:circleci`, `builtin:generic-env`)
- **Profile**: what “done” means for this repo (`deploy-release`, `semantic-release`, `asset-release`, etc.)
- **Release mode**:
  - `framework-managed` — Relay creates/updates the GitHub Release
  - `tool-observe` — another tool owns the release record; Relay observes it
  - `tool-wrap` — reserved, not implemented yet

## Built-in support

### Providers
- GitHub Actions
- CircleCI
- generic env/manual invocation

### Profiles
- deploy-release
- manual-release-pr
- semantic-release
- npm-package
- asset-release
- tag-only-module

### Common extensions
- Slack webhook notifications
- GitHub Release asset verification
- npm package visibility verification
- PR metadata enrichment from GitHub/release notes

### Version source options
- date / date-sha / date-time
- date-counter / backend-date-release
- template / explicit
- package-json / env / git-tag
- conventional-commits / changesets

## Quick start

### Requirements

- Node.js 20.x
- npm
- `GITHUB_TOKEN` for real GitHub Release mutations
- any plugin-specific secrets you configure, such as `SLACK_WEBHOOK_URL`

### Install and build

```bash
npm ci
npm run build
```

Examples below use `node dist/cli/main.js`, which works directly from this repo checkout. If you install Relay as a package, use the `relay` command instead.

### Minimal config

Create `.github/relay.yml`:

```yaml
api_version: 1
product_name: Example Web App
release_profile: deploy-release
release_mode: framework-managed
provider_plugin: builtin:github-actions
profile_plugin: builtin:deploy-release
stable_branches:
  - main
version_source:
  type: date-sha
tag_template: production-{date}-{short_sha}
notifiers:
  - plugin: builtin:slack-webhook
slack:
  enabled: true
  webhook_secret: SLACK_WEBHOOK_URL
```

### Inspect the resolved plan

```bash
node dist/cli/main.js inspect-config --config .github/relay.yml
```

### Preview normalized release JSON

```bash
node dist/cli/main.js normalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

### Finalize a real release

```bash
GITHUB_TOKEN=your-token \
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
node dist/cli/main.js finalize --config .github/relay.yml
```

## CLI commands

If you are running from this repo checkout instead of an installed package, replace `relay` with `node dist/cli/main.js`.

- `relay inspect-config` — validate config and show resolved plan
- `relay normalize` — emit normalized release JSON
- `relay finalize` — run the full finalization flow
- `relay render-notification` — preview notifier output without sending
- `relay list-plugins` — list built-in plugins
- `relay validate-plugin` — validate a plugin manifest/config/runtime contract

## GitHub usage

### Composite action

```yaml
- uses: ashwch/relay/actions/release-finalize@v1
  with:
    config_path: .github/relay.yml
```

### Reusable workflow

```yaml
jobs:
  release:
    uses: ashwch/relay/.github/workflows/release-finalize.yml@v1
    with:
      config_path: .github/relay.yml
    secrets: inherit
```

## Plugins

Relay supports built-in plugins and external plugins.

External plugins can be loaded through `path:` or `npm:` references and are executed through a small JSON contract over stdin/stdout. Use the plugin SDK for JavaScript/TypeScript plugins:

- package export: `@ashwch/relay/plugin-sdk`
- authoring guide: [`docs/plugin-authoring.md`](docs/plugin-authoring.md)
- examples: [`examples/plugins/`](examples/plugins/)

## Repository layout

```text
src/        TypeScript source
actions/    GitHub Action wrapper
docs/       focused documentation
examples/   example configs and example plugins
schemas/    JSON schemas
```

## Versioning examples

- [`examples/version-package-json.yml`](examples/version-package-json.yml) — recommended for npm package repos, including Relay itself
- [`examples/version-env.yml`](examples/version-env.yml) — use a CI-provided version
- [`examples/version-git-tag.yml`](examples/version-git-tag.yml) — derive from the current tag
- [`examples/version-conventional-commits.yml`](examples/version-conventional-commits.yml) — infer semver from conventional commits
- [`examples/version-changesets.yml`](examples/version-changesets.yml) — infer semver from pending Changesets

For full details, see [`docs/versioning.md`](docs/versioning.md).

## Documentation map

- [Config guide](docs/config.md)
- [Runtime surfaces](docs/runtime-surfaces.md)
- [Plugins overview](docs/plugins.md)
- [Plugin authoring](docs/plugin-authoring.md)
- [Finalize phases and notifications](docs/finalize-phases-and-notifications.md)
- [Release records](docs/release-records.md)
- [Types](docs/types.md)
- [Versioning](docs/versioning.md)
- [Validate plugin](docs/validate-plugin.md)
- [Examples](examples/README.md)

## Development

```bash
npm run build
npm run lint
npm run typecheck
npm test
```

## License

MIT
