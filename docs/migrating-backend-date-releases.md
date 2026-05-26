# Migrating Backend Date Releases

This guide explains how to move a repository onto relay when the
repository already thinks in date-based releases.

## The problem

Many teams like date releases because they are easy to read:

```text
2026.05.22
```

But eventually a practical issue appears:

```text
What happens when we need more than one release on the same day?
```

That is exactly what `backend-date-release` is for.

## First-principles goal

We want a migration path that preserves the familiar shape:

```text
first release of a day   -> 2026.05.22
second release that day  -> 2026.05.22.2
third release that day   -> 2026.05.22.3
```

while still giving the framework enough information to:

- detect reruns safely
- avoid duplicate release numbers
- keep GitHub tags interpretable

## Recommended target config

```yaml
api_version: 1
product_name: Example Backend
release_profile: deploy-release
release_mode: framework-managed
provider_plugin: builtin:github-actions
profile_plugin: builtin:deploy-release
tool_plugin: null
artifact_publishers: []
notifiers:
  - plugin: builtin:slack-webhook
metadata_enrichers: []
plugin_allowlist: []
allow_local_plugins: false
stable_branches:
  - main
version_source:
  type: backend-date-release
  counter_source: github-tag
  separator: .
tag_template: release-{version}
notes_source:
  type: static
slack:
  enabled: true
  webhook_secret: SLACK_WEBHOOK_URL
plugin_config: {}
```

## Why `tag_template: release-{version}` is recommended

Because the framework needs to learn from existing tags.

Good:

```yaml
tag_template: release-{version}
```

Why it is good:

```text
release-2026.05.22
release-2026.05.22.2
release-2026.05.22.3
```

The framework can inspect those tags later and understand the existing counter
history.

Bad:

```yaml
tag_template: stable-release
```

Why it is bad:

```text
there is no visible date or counter information in the tag
```

That means same-day counter derivation cannot work safely.

## Migration strategy

### Step 1: choose the durable tag shape

Pick a tag template that exposes either:

- `{version}`
- or `{counter}`

Usually the simplest answer is:

```yaml
tag_template: release-{version}
```

### Step 2: decide how counters should be resolved

#### Option A: framework derives counters from existing tags

```yaml
version_source:
  type: backend-date-release
  counter_source: github-tag
```

Use this when:

- tags already exist in a readable shape
- you want the framework to pick the next same-day number automatically

#### Option B: upstream process provides the counter explicitly

```yaml
version_source:
  type: backend-date-release
  counter_source: explicit
  counter: 3
```

Use this when:

- another release system already knows the next number
- you want the framework to follow that decision exactly

## How reruns behave

With `counter_source: github-tag`, reruns of the same commit are meant to reuse
an existing same-day number when possible.

That means:

```text
commit A -> release-2026.05.22.2
rerun commit A -> still release-2026.05.22.2
```

not:

```text
commit A -> release-2026.05.22.2
rerun commit A -> release-2026.05.22.3
```

That behavior is important because retrying CI should not silently mint a new
release identity for the same code.

## Dry-run preview command

Before switching a real repository, preview the resolved version locally:

```bash
GITHUB_TOKEN=your-token \
  relay normalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/example-backend \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

This helps answer:

```text
What version would the framework choose today?
What tag would it create or observe?
```

## Full finalize example

```bash
GITHUB_TOKEN=your-token \
  relay finalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/example-backend \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main
```

## Sanity checklist

Before migrating a real backend-style repo, verify:

- [ ] `version_source.type` is `backend-date-release`
- [ ] `tag_template` exposes `{version}` or `{counter}`
- [ ] existing tags follow one readable pattern
- [ ] dry-run resolves the expected same-day version
- [ ] rerun behavior is understood
- [ ] GitHub token permissions are available for real release mutation

## Files to read next

1. `docs/versioning.md`
2. `docs/config.md`
3. `src/core/release-json/versioning.ts`
4. `tests/versioning.test.ts`
