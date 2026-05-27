# Versioning Guide

This file explains how relay versioning works and why the new
options were added.

## Why this matters

Different projects do not all want the same release version shape.

Examples:

```text
2026.05.22
2026.05.22.2
2026.05.22-9f3c1d2
2026.05.22.191302
2026.05.22.4-9f3c1d2
2.3.4
4.5.6
0.2.0
```

A shared framework has to support that without forcing every repository into one
schema.

## First-principles model

A versioning strategy answers two separate questions:

```text
1. What should the version string look like?
2. Where should that version come from?
```

Some repos already know the answer before Relay starts:

```text
package.json already says 2.3.4
current tag already says v2.3.4
CI already exported RELEASE_VERSION=2.3.4
```

Other repos want Relay to compute the answer:

```text
today's date
existing tags
conventional commits
pending changesets
```

That is why versioning now supports both:

- direct observation of versions that already exist elsewhere
- computed version strategies for repos that want Relay to infer the next value
- optional counter resolution for same-day uniqueness

## Two families of version sources

### Observe an existing version

Use these when another part of the repo or pipeline already knows the final
version:

- `explicit`
- `file`
- `env`
- `git-tag`

### Compute or infer a version

Use these when Relay should derive the version itself:

- `date`
- `date-sha`
- `date-time`
- `date-counter`
- `backend-date-release`
- `template`
- `conventional-commits`
- `changesets`

## Supported version source types

### `date`

```yaml
version_source:
  type: date
```

Example output:

```text
2026.05.22
```

Use when one release per day is enough.

## `date-sha`

```yaml
version_source:
  type: date-sha
```

Example output:

```text
2026.05.22-9f3c1d2
```

Use when uniqueness by commit is enough.

## `date-time`

```yaml
version_source:
  type: date-time
  separator: .
  time_precision: seconds
```

Example output:

```text
2026.05.22.191302
```

Use when you want time-based uniqueness.

## `date-counter`

```yaml
version_source:
  type: date-counter
  counter_source: github-tag
  separator: .
```

Example outputs:

```text
first release of the day  -> 2026.05.22.1
second release of the day -> 2026.05.22.2
third release of the day  -> 2026.05.22.3
```

Use when several releases can happen on the same day and you want an explicit
release number.

## `backend-date-release`

```yaml
version_source:
  type: backend-date-release
  counter_source: github-tag
  separator: .
```

Example outputs:

```text
first release of the day  -> 2026.05.22
second release of the day -> 2026.05.22.2
third release of the day  -> 2026.05.22.3
```

This is the backend-friendly date schema.

Why it is different from `date-counter`:

```text
first release of the day -> plain date
later releases that day  -> date + numeric suffix
```

That makes it compatible with repositories that want plain date versions most of
the time, but still need a safe path for multiple same-day releases.

## `template`

```yaml
version_source:
  type: template
  template: '{date}.{counter}-{short_sha}'
  counter_source: explicit
  counter: 4
```

Example output:

```text
2026.05.22.4-9f3c1d2
```

Use when a project wants a custom organization-specific or ecosystem-specific
schema without adding a whole new framework codepath.

Important rule:

```text
Do not reference {version} inside version_source.template.
```

That would be recursive. Use concrete fields such as `{date}`, `{counter}`,
`{short_sha}`, `{sha}`, `{branch}`, or `{time}` instead.

## `explicit`

```yaml
version_source:
  type: explicit
  value: 2026.05.22.7
```

Use when an upstream system already decided the final version string.

## `file`

```yaml
version_source:
  type: file
  format: toml
  path: pyproject.toml
  key_path:
    - project
    - version
```

Example outputs:

```text
package.json        -> 2.3.4
.release-version.yml -> 5.6.7
pyproject.toml      -> 0.8.1
```

Use when a repo already stores a static version in a structured file and Relay
should observe that exact value instead of inventing another source of truth.

Visual model:

```text
workspaceRoot + path
  ↓
parse one file by format
  ↓
walk key_path
  ↓
require one non-empty string
  ↓
use that exact value as the release version
```

Supported formats:

- `json`
- `yaml`
- `toml`

Common examples:

```yaml
version_source:
  type: file
  format: json
  path: package.json
  key_path:
    - version
```

```yaml
version_source:
  type: file
  format: toml
  path: Cargo.toml
  key_path:
    - package
    - version
```

```yaml
version_source:
  type: file
  format: yaml
  path: .release-version.yml
  key_path:
    - release
    - version
```

Important scope rule:

```text
This source is for static file-backed versions only.
```

It does not currently support:

- dynamic Python versioning such as `dynamic = ["version"]`, `setuptools_scm`, or Hatch-managed dynamic versions
- Cargo workspace-inherited versions such as `version.workspace = true`
- Go release versioning derived from `go.mod`

When one of those dynamic cases applies, use another source of truth such as
`git-tag`, `env`, or `explicit`.

Helpful commands:

```bash
# confirm the config shape and planned versioning surface
node dist/cli/main.js inspect-config --config examples/version-package-json.yml
node dist/cli/main.js inspect-config --config examples/version-pyproject-toml.yml
node dist/cli/main.js inspect-config --config examples/version-cargo-toml.yml
node dist/cli/main.js inspect-config --config examples/version-custom-yaml.yml
```

Runtime note:

```text
The file path is resolved relative to workspaceRoot.
```

So a real `normalize` or `finalize` run must happen from a checkout where the
configured file actually exists at that relative path.

## `env`

```yaml
version_source:
  type: env
  key: RELEASE_VERSION
```

Example output:

```text
3.4.5
```

Use when an upstream CI system or release tool already resolved the final
version and exposes it as an environment variable.

## `git-tag`

```yaml
version_source:
  type: git-tag
  pattern: '^v(?<version>.+)$'
```

The pattern must capture the version, either with `(?<version>...)` or the
first positional capture group.

Example output:

```text
4.5.6
```

Use when the current tag ref is already the release source of truth.

Quick local preview:

```bash
relay normalize \
  --config examples/version-git-tag.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/example-service \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --tag v4.5.6 \
  --dry-run
```

## `conventional-commits`

```yaml
version_source:
  type: conventional-commits
  tag_prefix: v
  initial_version: 0.1.0
  default_increment: patch
```

Example output:

```text
0.2.0
```

Use when the repo already follows conventional commits and you want Relay to
infer the next semver bump from git history instead of PR labels.

Important tag rule:

```text
tag_template should expose {version}
```

Why?

Because Relay needs future tags to remain readable as semver history.
A tag like `v{version}` or `release-{version}` works. A tag like
`stable-release` does not.

Relay uses the latest matching semver tag that is reachable from the current
commit, not an unrelated higher tag from another branch.

Current built-in inference rules are intentionally simple:

- `BREAKING CHANGE:` or `type!:` → `major`
- `feat:` → `minor`
- `fix:`, `perf:`, `revert:` → `patch`
- no recognized commit type → `default_increment` or `patch`

If the current commit already has the latest matching semver tag, Relay reuses
that version instead of incrementing again on reruns.

If no previous matching semver tag exists yet, Relay uses `initial_version` as
that repository's first resolved version.

Quick local preview:

```bash
relay normalize \
  --config examples/version-conventional-commits.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/example-service \
  --sha <current-sha> \
  --branch main \
  --dry-run
```

This source reads local git history, so the command is most useful from inside a
real repo checkout.

## `changesets`

```yaml
version_source:
  type: changesets
  directory: .changeset
  package: '@example/component-library'
  tag_prefix: v
  initial_version: 0.1.0
```

Example output:

```text
0.2.0
```

Use when the repo already uses Changesets and Relay should infer the next
semver bump from pending `.changeset/*.md` files for one package.

Important tag rule:

```text
tag_template should expose {version}
```

For the same reason as conventional-commits: future Relay runs need to learn
semver history back from existing tags.

Relay uses the latest matching semver tag that is reachable from the current
commit, not an unrelated higher tag from another branch.

Relay takes the highest matching bump for the selected package:

```text
major > minor > patch
```

If the current commit already has the latest matching semver tag, Relay reuses
that version instead of incrementing again.

If no previous matching semver tag exists yet, Relay uses `initial_version` as
the first resolved version.

Quick local preview:

```bash
relay normalize \
  --config examples/version-changesets.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/component-library \
  --sha <current-sha> \
  --branch main \
  --dry-run
```

This source reads both local git history and local `.changeset/*.md` files, so
it is also best previewed from a real repo checkout.

## Counter sources

For counter-based schemas, there are two main modes.

### `counter_source: explicit`

```yaml
version_source:
  type: date-counter
  counter_source: explicit
  counter: 2
```

Use this when some external process already knows the right same-day number.

### `counter_source: github-tag`

```yaml
version_source:
  type: date-counter
  counter_source: github-tag
```

Use this when the framework should inspect existing repository tags and compute
what the next same-day release number should be.

Visual model:

```text
look at existing tags
→ find tags matching this schema for today
→ if current commit already has one, reuse it
→ otherwise increment the highest one
```

That last detail matters.

It means reruns of the same commit can reuse the same version instead of
accidentally creating a brand new same-day release number.

## Early validation guardrails

The framework now rejects some invalid combinations during config validation,
not only later at runtime.

Examples of config that now fail early:

- counter-based schemas with a tag template that hides the counter entirely
- custom version templates that recursively reference `{version}`
- `counter_source: explicit` without a positive `counter`

## Tag template placeholders

The framework understands these placeholder names in tag templates:

- `{version}` → the final resolved version string
- `{date}` → date in `YYYY.MM.DD` form
- `{counter}` → same-day release number when applicable
- `{short_sha}` → first 7 characters of the commit SHA
- `{sha}` → full commit SHA
- `{branch}` → ref/branch name
- `{time}` → UTC time component used by `date-time`

Example:

```yaml
tag_template: nightly-{date}.{time}-{short_sha}
```

Example output:

```text
nightly-2026.05.22.191302-9f3c1d2
```

## Important tag template rule for auto counters

If you use `counter_source: github-tag`, the framework needs to be able to learn
from existing tags.

So the tag template must include either:

- `{version}`
- or `{counter}`

Example:

```yaml
tag_template: release-{version}
```

Good.

Example:

```yaml
tag_template: release-{date}.{counter}
```

Also good.

Example:

```yaml
tag_template: stable-release
```

Not good for automatic counters, because existing tags do not reveal enough
information.

## Example configurations

### Backend-style same-day releases

```yaml
version_source:
  type: backend-date-release
  counter_source: github-tag
  separator: .
tag_template: release-{version}
```

### Frontend-style date + sha releases

```yaml
version_source:
  type: date-sha
tag_template: production-{version}
```

### Project-specific custom schema

```yaml
version_source:
  type: template
  template: '{date}.{counter}-{short_sha}'
  counter_source: github-tag
tag_template: release-{version}
```

## Helpful commands

### Preview a versioning scheme locally

```bash
relay normalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

### Preview an auto-counter scheme against real repository tags

```bash
GITHUB_TOKEN=your-token \
  relay normalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

## Files to read next

1. `src/core/release-json/versioning.ts`
2. `src/core/release-json/schema.ts`
3. `src/core/github/tags.ts`
4. `tests/versioning.test.ts`
