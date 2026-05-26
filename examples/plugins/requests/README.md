# Sample Request Fixtures

These files are example request fixtures for `validate-plugin`.

Why they exist:

```text
plugin authors often need richer inputs than the built-in defaults
without wiring a full release flow first
```

Visual model:

```text
request fixture JSON
        ↓
relay validate-plugin --request-json ...
        ↓
plugin runs against realistic hook input
```

## Available fixtures

```text
normalize.request.json
plan.request.json
observe.request.json
publish.request.json
verify.request.json
enrich.request.json
render.request.json
notify.request.json
```

Important note for provider authors:

```text
normalize.request.json uses full release-config shape in its config field
```

That means it can be used directly with provider plugins such as
`builtin:generic-env` during `validate-plugin` runs.

## Example usage

Validate the checked-in example enricher with a richer enrich request:

```bash
relay validate-plugin \
  path:./examples/plugins/example-enricher \
  --request-json examples/plugins/requests/enrich.request.json
```

Validate a notifier with a notify-shaped request:

```bash
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/notify.request.json
```

Validate a multi-hook notifier against more than one fixture in one run:

```bash
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/render.request.json \
                 examples/plugins/requests/notify.request.json
```

Validate the same notifier by pointing at a directory of `<hook>.request.json` files:

```bash
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json-dir examples/plugins/requests
```

If you also pass `--hook`, make sure it matches the fixture hook:

```bash
relay validate-plugin \
  path:./plugins/my-notifier \
  --hook notify \
  --request-json examples/plugins/requests/notify.request.json
```

Why be strict here?

```text
fixture says "this is a notify-shaped request"
        ↓
command should not quietly treat it as render-shaped validation
```

## Important rule

Hook selection now works like this:

```text
--hook provided                -> validate that hook
--request-json provided only   -> validate the fixture's hook
neither provided              -> validate all declared hooks
```

Why this rule exists:

```text
request fixtures usually describe one concrete hook input
        ↓
using that same fixture for unrelated hooks would be confusing
```

If you pass more than one fixture, treat them as:

```text
one fixture
→ one hook
→ one request shape
```

Directory mode follows the same rule. It just discovers the fixture paths for
you by looking for:

```text
<hook>.request.json
```

And it behaves like this:

```text
one or more matching fixtures -> validate those hooks
zero matching fixtures        -> fail clearly
extra unrelated files         -> ignore them
```

A request fixture is a JSON object that mirrors the plugin-facing request shape
for the fields an author typically needs to control:

```text
hook
dry_run
config
release
inputs
secrets
workspace
```

The framework still owns plugin metadata such as plugin name and version.

## Good mental model

```text
--plugin-config-json -> validate one config object
--request-json       -> validate one fuller hook input shape
```

Common fixture mistakes to avoid:

```text
- forgetting hook
- forgetting dry_run
- forgetting release
- using non-string values in env/files/secrets
- passing a release object that is not valid normalized release JSON
```

Use `--request-json` when you want to test:

- a specific hook
- a richer release document
- realistic args/env/files
- secret wiring assumptions
- workspace-root-sensitive behavior

Useful progression for a multi-hook plugin:

```bash
# start with static validation
relay validate-plugin path:./plugins/my-notifier --no-exec

# then validate one hook-shaped fixture at a time
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/render.request.json

relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/notify.request.json

# or validate both in one run
relay validate-plugin \
  path:./plugins/my-notifier \
  --request-json examples/plugins/requests/render.request.json \
                 examples/plugins/requests/notify.request.json
```
