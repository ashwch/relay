# Release Record Guide

This file explains the new GitHub Release behavior in plain language.

## The problem this code solves

A release framework needs one durable answer to this question:

```text
What code actually shipped?
```

For v1, our durable answer is:

```text
GitHub Release + Git tag
```

That is why the framework now has explicit GitHub release helpers.

## First-principles mental model

There are two safe high-level paths implemented right now, plus one reserved future path.

### Path 1: `framework-managed`

Use this when the framework itself should own the release record.

```text
figure out expected tag
→ check whether a GitHub Release already exists
→ check whether the tag already exists
→ create missing pieces
→ update existing pieces when safe
```

### Path 2: `tool-observe`

Use this when some other tool already owns release creation.

```text
read the tag reported by the tool
→ if a tag exists, verify the GitHub Release exists
→ verify the tag points at the expected commit
→ continue with shared framework behavior
```

This is the safe path for semantic-release-style repositories.

Normal semantic-release no-op:

```text
semantic-release found no release-worthy commits
→ no tag is reported
→ relay returns status=noop
→ no GitHub Release lookup, artifact work, or Slack notification runs
```

Why this matters:

```text
missing tag after "release created" = error
missing tag after "no release created" = noop
```

### Reserved path: `tool-wrap`

`tool-wrap` means:

```text
framework invokes a release tool
→ release tool publishes/tag/releases
→ framework observes and validates what the tool did
→ framework continues with artifacts, metadata, and notifications
```

It is different from `tool-observe`:

```text
tool-observe = tool already ran before finalize starts
tool-wrap    = finalize would run the tool itself
```

`tool-wrap` is not implemented yet. The runtime fails fast instead of guessing,
because invoking a release tool can create irreversible tags, packages, or
GitHub Releases.

For the fuller design sketch, read:

- `docs/tool-wrap.md`

## Why we verify tags so carefully

A GitHub Release is only trustworthy if its tag points at the expected commit.

If we skipped that check, we could accidentally say:

```text
"release X shipped commit A"
```

when the tag actually points at:

```text
commit B
```

That would make downstream notifications and audit trails wrong.

So the framework fails closed instead.

## Why annotated tags matter

Git tags are not always simple pointers straight to a commit.

Sometimes the ref points to an **annotated tag object**, which then points to:

- another tag object, or
- a final commit

So the framework resolves tags like this:

```text
ref
→ tag object
→ maybe another tag object
→ final commit sha
```

That is why `src/core/github/tags.ts` exists.

## What the core GitHub files do

### `src/core/github/client.ts`
Small GitHub HTTP wrapper.

Purpose:
- set headers consistently
- handle tokens consistently
- parse responses consistently
- make errors easier to understand

### `src/core/github/tags.ts`
Git tag correctness helpers.

Purpose:
- look up tag refs
- resolve annotated tags to their final commit
- create a tag ref when needed
- fail if an existing tag points at the wrong commit

### `src/core/github/releases.ts`
GitHub Release record helpers.

Purpose:
- create a release when missing
- update an existing release when safe
- observe an existing tool-owned release without duplicating it

## `framework-managed` algorithm

Today the implementation follows this shape:

```text
1. check for existing release by tag
2. check for existing tag by name
3. if release exists:
     verify tag target
     update release
4. if release does not exist but tag exists:
     verify tag target
     create release from that tag
5. if neither exists:
     create tag
     create release
```

## Dry-run behavior

Dry-run should still tell the truth about intent without mutating GitHub.

So in dry-run mode the framework does this:

```text
compute expected tag
compute expected release URL
report status=noop
skip all GitHub writes
```

That gives calling CI enough information to preview what would happen.

All examples below use neutral placeholder repositories such as
`ExampleOrg/web-app` so the guide stays organization-agnostic.

## Example: real framework-managed finalize

```bash
GITHUB_TOKEN=your-token \
  relay finalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main
```

## Example: observe an existing semantic-release repo

```bash
GITHUB_TOKEN=your-token \
  relay finalize \
  --config .github/relay.yml \
  --provider builtin:circleci \
  --tag v2026.05.22-9f3c1d2
```

In that second case the framework should **not** create a duplicate GitHub Release.

## Tests that document this behavior

Read these tests if you want executable examples:

- `tests/finalize.test.ts`
- `tests/github-tags.test.ts`

They demonstrate:
- creating a new tag + release
- updating an existing release
- observing a tool-owned release
- resolving nested annotated tags

## Files to read next

1. `src/core/github/client.ts`
2. `src/core/github/tags.ts`
3. `src/core/github/releases.ts`
4. `src/core/orchestration/finalize-run.ts`
