# Tool-wrap Mode

`tool-wrap` is a reserved release mode.

It is not implemented yet.

This guide explains what it means, why it is different from `tool-observe`, and
what must be true before it is safe to implement.

## The short version

```text
tool-observe = release tool already ran before release-framework starts
tool-wrap    = release-framework would run the release tool itself
```

Today, if a config uses:

```yaml
release_mode: tool-wrap
```

the runtime fails fast.

That is intentional.

## Why the mode exists

Some repositories already use release tools such as:

- semantic-release
- custom publish scripts
- package registry release commands
- staged asset publishing tools

The framework should not force those repositories to rewrite their release
process.

Instead, a future safe `tool-wrap` flow could look like this:

```text
normalize provider input
  ↓
profile plan
  ↓
run release tool
  ↓
observe what the tool created
  ↓
verify GitHub tag + GitHub Release
  ↓
run artifacts / enrichers / notifications
```

That would let the framework provide one shared final-mile contract while still
letting a specialized release tool do the actual publishing.

## Why it is not implemented yet

Running a release tool is not like rendering a message.

It can create irreversible state:

```text
Git tag
GitHub Release
npm package
container image
S3 object
customer-visible deployment
```

If the framework guessed wrong, it could duplicate a release or publish from the
wrong commit.

So the current rule is:

```text
fail closed until tool-wrap has a safe contract
```

## Current safe modes

### `framework-managed`

Use this when the framework owns the GitHub Release record.

```text
framework computes tag/version
  ↓
framework verifies or creates tag
  ↓
framework creates or updates GitHub Release
  ↓
shared final-mile phases
```

### `tool-observe`

Use this when another tool already ran.

```text
release tool has already created tag/release
  ↓
framework observes existing result
  ↓
framework verifies tag target
  ↓
shared final-mile phases
```

This is the recommended mode for semantic-release-style repositories today.

## What a safe tool-wrap implementation needs

A future implementation should be explicit about all of these things.

### 1. Tool publish hook

A release-tool plugin would need a `publish` hook:

```text
request.release
  ↓
tool publish hook
  ↓
created tag/release/package facts
```

The hook must return enough information for core to validate what happened.

### 2. Observe after publish

After publish, core should still observe the durable record.

```text
publish
  ↓
observe GitHub Release by expected tag
  ↓
verify tag target SHA
```

The framework should not trust "publish succeeded" without checking the durable
record.

### 3. Idempotency rules

The tool plugin must define safe rerun behavior.

Questions to answer:

- If the tag already exists, is that success or failure?
- If the package already exists, is that success or failure?
- If a previous run partially succeeded, how does the second run continue?
- What exact key prevents duplicate release records?

For v1, the durable idempotency key remains:

```text
repository + tag
```

### 4. Dry-run semantics

Dry-run must not publish anything.

A safe dry-run should report intent:

```json
{
  "tool": "example-release-tool",
  "status": "dry-run",
  "would_publish_tag": "v1.2.3"
}
```

### 5. Permission declaration

The plugin manifest must declare the permissions it needs.

Examples:

```json
{
  "permissions": {
    "github": { "contents": "write" },
    "network": ["npm-registry"]
  }
}
```

A reviewer should be able to tell from the manifest whether the plugin can
mutate GitHub, publish packages, or call external services.

### 6. No duplicate GitHub Releases

The most important safety property:

```text
tool-wrap must not create a second GitHub Release
when the tool already created the intended one
```

That means the post-publish observe step is mandatory.

## Proposed future flow

```text
provider.normalize
  ↓
profile.plan
  ↓
release_tool.publish        # future hook
  ↓
release_tool.observe        # validate tool output shape
  ↓
core observeGitHubRelease   # validate durable record + tag target
  ↓
artifact publishers
  ↓
metadata enrichers
  ↓
notifiers
```

## Required tests before implementation

A real `tool-wrap` implementation should include tests for:

- dry-run does not call the tool
- publish hook is called exactly once on real run
- observe runs after publish
- existing correct tag/release rerun is safe
- existing wrong tag target fails
- missing GitHub Release after publish fails
- tool-created release does not get duplicated by core
- notification does not send if publish/observe fails

## Current behavior

The runtime currently fails with:

```text
tool-wrap release mode is not implemented yet
```

That failure is preferable to a partial implementation that might publish from
the wrong commit.

## When to use each mode

```text
Need framework to create/update GitHub Release?
  -> framework-managed

Another tool already creates GitHub Release before finalization?
  -> tool-observe

Want release-framework to run the tool itself?
  -> not supported yet; future tool-wrap
```

## Files to read next

- `src/core/orchestration/finalize-run.ts`
- `src/core/plugins/request-response.ts`
- `src/plugins/builtin/release-tools/semantic-release/index.ts`
- `docs/release-records.md`
- `docs/finalize-phases-and-notifications.md`
