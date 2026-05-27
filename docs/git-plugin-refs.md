# Git Plugin Refs

This guide explains Relay's `git:` plugin refs in simple language.

The short version is:

```text
put the plugin in a Git repo
point relay.yml at that repo directly
let Relay clone/fetch it when needed
```

---

## Why this exists

Before `git:` support, teams often had to do something like this in CI:

```yaml
- run: git clone https://github.com/acme/relay-plugins.git .github/relay-plugins
- run: cd .github/relay-plugins/slack-notify && npm install
```

Then their Relay config still had to point at a local path:

```yaml
plugin_allowlist:
  - path:.github/relay-plugins/slack-notify

notifiers:
  - plugin: path:.github/relay-plugins/slack-notify
```

That works, but it spreads plugin loading across two places:

```text
CI workflow decides where plugin code comes from
relay.yml decides which plugin should run
```

`git:` support pulls those back together.

New mental model:

```text
relay.yml says both:
- which plugin should run
- where Relay should load it from
```

---

## The format

```text
git:<host>/<owner>/<repo>//<optional/subdir>@<optional-ref>
```

Examples:

```text
git:github.com/acme/relay-plugins//slack-notify@main
git:github.com/acme/relay-plugins//slack-notify@v1.2.3
git:github.com/acme/relay-plugins//slack-notify@9f3c1d2
git:github.com/acme/relay-plugins
```

Visual breakdown:

```text
git:github.com/acme/relay-plugins//slack-notify@main
    |          |                     |             |
    |          |                     |             └─ git ref (branch, tag, or SHA)
    |          |                     └─ plugin subdirectory inside the repo
    |          └─ repository path
    └─ host
```

Important parsing rules:

```text
last @  -> git ref separator
//      -> plugin subdirectory separator
first / -> host separator
```

Why split on the **last** `@`?

Because a subdirectory can contain `@`, but the final `@` is the only place
where Relay treats the rest of the string as the git ref.

Example:

```text
git:github.com/acme/relay-plugins//alerts@v2@main
```

Relay reads that as:

```text
subdir = alerts@v2
ref    = main
```

---

## What Relay actually does

When Relay sees a `git:` plugin ref, the flow is:

```text
parse ref
  ↓
choose deterministic cache directory
  ↓
if clone is needed:
  clone into a unique temp sibling first
  then rename into the final cache path
  ↓
if @ref was provided:
  fetch that branch/tag/SHA
  checkout FETCH_HEAD
  ↓
resolve plugin root (repo root or subdirectory)
  ↓
realpath-check that the plugin root still stays inside the cloned repo
  ↓
install runtime dependencies with a non-dirty npm mode
  ↓
load plugin-manifest.json from that root
```

That means `git:` is still just another way to answer the loader's main
question:

```text
what plugin root directory should Relay trust for this plugin ref?
```

After that point, `git:` plugins behave like other external plugins.

---

## Config example

```yaml
plugin_allowlist:
  - git:github.com/acme/relay-plugins//slack-notify@main

notifiers:
  - plugin: git:github.com/acme/relay-plugins//slack-notify@main
```

Same idea for enrichers:

```yaml
plugin_allowlist:
  - git:github.com/acme/relay-plugins//pr-context@v1.0.0

metadata_enrichers:
  - plugin: git:github.com/acme/relay-plugins//pr-context@v1.0.0
```

Why must the ref also be in `plugin_allowlist`?

Because Relay keeps the trust boundary explicit.

```text
configured plugin usage
and
allowed external plugin source
should match exactly
```

If the plugin also needs plugin-local config, use the exact same full ref as
the key under `plugin_config`:

```yaml
plugin_config:
  git:github.com/acme/relay-plugins//slack-notify@main:
    channel: releases
```

---

## Cache behavior

Relay stores cloned git plugin repos in a deterministic cache.

Cache root precedence:

```text
1. RELAY_GIT_CACHE_DIR
2. RUNNER_TEMP/relay-git-cache
3. TMPDIR|TEMP|TMP + /relay-git-cache
4. ~/.relay/cache/git
```

Visual model:

```text
cache root
  ↓
<host>/<repoPath>
  ↓
repo | ref-<hash>
```

So these refs:

```text
git:github.com/acme/relay-plugins//slack-notify
git:github.com/acme/relay-plugins//slack-notify@main
git:github.com/acme/relay-plugins//slack-notify@v1.2.3
```

land in cache directories shaped like:

```text
~/.relay/cache/git/github.com/acme/relay-plugins/repo
~/.relay/cache/git/github.com/acme/relay-plugins/ref-<hash-of-main>
~/.relay/cache/git/github.com/acme/relay-plugins/ref-<hash-of-v1.2.3>
```

Why include the ref in the cache key for pinned refs?

```text
same repo + different pinned refs
  should not share one mutable checkout
```

Otherwise one Relay process could check out `@main` while another expected
`@v1.2.3`, and both would be mutating the same working tree.

Why keep one shared `repo` cache for the unpinned case?

Because the ref-less form is already a local-dev convenience and does not claim
strong pinning semantics.

Why clone into a temp sibling first instead of straight into the final cache
path?

```text
final cache path should mean "ready to use"
not "maybe another process crashed halfway through cloning"
```

That temp-clone pattern also makes concurrent first-time loads safer:

```text
process A clones temp-A
process B clones temp-B
one rename wins
other process notices a valid cache already exists and reuses it
```

---

## Pinned vs unpinned refs

Pinned ref:

```text
git:github.com/acme/relay-plugins//slack-notify@main
git:github.com/acme/relay-plugins//slack-notify@v1.2.3
git:github.com/acme/relay-plugins//slack-notify@9f3c1d2
```

Unpinned ref:

```text
git:github.com/acme/relay-plugins//slack-notify
```

Current behavior:

```text
with @ref
  -> Relay fetches that ref and checks out FETCH_HEAD

without @ref
  -> Relay clones once and reuses the existing cache as-is
```

Why not auto-update the unpinned case?

Because silent background updates are surprising.
A ref-less plugin is intentionally treated as a local-dev convenience.

---

## Why Relay uses clone + fetch + checkout

You might expect this:

```bash
git clone --depth 1 --branch <ref> ...
```

But that does not work for raw commit SHAs.

Relay uses this shape instead:

```text
clone repo
  ↓
fetch requested ref
  ↓
checkout FETCH_HEAD
```

Why?

Because one path now works for all three common cases:

```text
branch
 tag
 SHA
```

That keeps the loader logic simple.

---

## Commands you will actually use

### Parse/loader smoke test

```bash
node -e "const { parseGitPluginRef } = require('./dist/core/plugins/git-cache.js'); console.log(parseGitPluginRef('git:github.com/acme/relay-plugins//slack-notify@main'));"
```

### Static validation

```bash
relay validate-plugin git:github.com/acme/relay-plugins//slack-notify@main --no-exec
```

Important nuance:

```text
--no-exec means "do not run plugin hooks"
it does not mean "do not resolve or clone the plugin"
```

Why?

Because Relay still has to load the manifest and validate the plugin contract.
A `git:` plugin cannot do that until the repo exists locally.

### Install-time script behavior

Relay installs plugin-local runtime dependencies with one of these commands:

```bash
# lockfile present
npm ci --omit=dev --ignore-scripts

# no lockfile present
npm install --omit=dev --ignore-scripts --package-lock=false
```

Why ignore lifecycle scripts?

```text
plugin install happens during resolution
resolution should not inherit arbitrary CI secrets
```

Why disable lockfile writes in the no-lockfile case?

```text
the git cache should stay reusable across later fetch/checkout cycles
```

A generated or modified `package-lock.json` would make the cached checkout
look dirty and could interfere with later reuse of that same cached ref.

That keeps install-time subprocesses closer to Relay's normal external-plugin
trust model, where runtime behavior is driven by an explicit request contract
instead of ambient process environment.

### End-to-end validation

```bash
relay validate-plugin git:github.com/acme/relay-plugins//slack-notify@main
```

### Inspect config before a real run

If you copied an example ref like `acme/relay-plugins`, replace it with a real
reachable repository first.

```bash
relay inspect-config --config .github/relay.yml
```

### Finalize in dry-run mode

```bash
relay finalize \
  --config .github/relay.yml \
  --provider builtin:generic-env \
  --repo ExampleOrg/web-app \
  --sha 9f3c1d2f5b1c9f7a8f4d2e1b0c6a5d4e3f2a1b0c \
  --branch main \
  --dry-run
```

---

## Security and trust model

`git:` does **not** mean "load arbitrary internet code by default".

Guardrails still apply:

```text
plugin ref must be explicit
plugin ref must be allowlisted
plugin-manifest.json must exist
resolved plugin root must stay inside the cloned repo
```

That last rule matters.

A git plugin ref may narrow from:

```text
repo root
  ↓
plugin subdirectory
```

but it may not escape upward out of the repository cache with `..` segments.

And Relay now checks the real filesystem target too, not only the lexical path.

Why?

```text
repo/subdir could be a symlink
symlink target could point outside the cloned repo
```

So Relay resolves the real path after cloning and rejects plugin roots whose
actual target escapes the cached repository.

---

## Operational limits to remember

### Private repositories need credentials

Relay builds clone URLs like:

```text
https://<host>/<repoPath>.git
```

So private repos need normal Git auth to work in that environment.

### npm install is plugin-local

If the resolved plugin root contains `package.json`, Relay runs one of these:

```bash
# lockfile present
npm ci --omit=dev --ignore-scripts

# no lockfile present
npm install --omit=dev --ignore-scripts --package-lock=false
```

inside that plugin root.

Why there?

Because the plugin executes from its own directory. Relay does not assume the
caller repo's `node_modules` should satisfy plugin runtime dependencies.

Why ignore lifecycle scripts?

Because install-time scripts would run during plugin resolution, before Relay
switches to its normal minimal runtime contract for external plugins.

Why mention the two install modes again here?

```text
lockfile present -> keep the cached checkout stable with npm ci
no lockfile      -> avoid generating a new package-lock.json in the cache
```

### Monorepo package management is the plugin author's concern

If a plugin depends on workspace-level install behavior, that repo may need a
more specialized packaging strategy than `git:` loading alone.

---

## When to use each external ref type

### `path:`
Use when the plugin code already lives in the same repo or worktree.

### `npm:`
Use when the plugin is packaged and published like a normal dependency.

### `git:`
Use when the plugin should stay in a Git repo but you do not want to require:

```text
manual CI clone steps
or
npm publishing before every config consumer can use it
```

---

## Good mental model to keep

```text
path:/npm:/git:
  are three different transport mechanisms
  for answering one loader question:

  "what plugin root directory should Relay load?"
```

That is why the rest of the loader stays small.
Once Relay has a trustworthy plugin root plus `plugin-manifest.json`, the usual
plugin contract rules apply.
