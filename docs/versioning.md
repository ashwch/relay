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
```

A shared framework has to support that without forcing every repository into one
schema.

## First-principles model

A versioning strategy answers two separate questions:

```text
1. What should the version string look like?
2. How do we keep it unique when more than one release happens on the same day?
```

That is why versioning now supports both:

- multiple built-in version source types
- optional counter resolution

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
2026.05.22.1
2026.05.22.2
2026.05.22.3
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
2026.05.22
2026.05.22.2
2026.05.22.3
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
