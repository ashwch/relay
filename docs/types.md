# Shared Types Guide

This file explains why the framework now has small shared runtime and JSON types.

## The problem

A release framework crosses many boundaries:

```text
YAML config
→ CLI args
→ environment variables
→ plugin requests
→ JSON files
→ HTTP APIs
```

If every file describes those boundaries with fresh ad-hoc object types, the code gets noisy fast.

That is why we added shared types.

## The main idea

We want the type names to explain intent.

Instead of reading this repeatedly:

```text
Record<string, string | undefined>
```

we would rather read:

```text
EnvMap
```

That is not about cleverness.

It is about making the code easier to understand at a glance.

## The new shared types

### `JsonValue`
Represents any JSON-safe value.

Use this when data is crossing a serialized boundary.

### `JsonObject`
Represents a JSON object.

Use this when you need a generic JSON-shaped map.

### `EnvMap`
Represents environment variables.

Use this when a function reads process-like environment input.

### `RuntimeArgs`
Represents CLI/runtime arguments.

Use this when values come from a command invocation and may still be loosely shaped.

### `StringMap`
Represents a plain string-to-string map.

Use this for file maps, secret maps, or similar simple runtime bags.

### `UnknownMap`
Represents an intentionally flexible object map.

Use this when the boundary is real but the exact shape is still plugin-defined
or extension-defined.

This is preferred over repeating raw `Record<string, unknown>` everywhere,
because the name explains intent even when the shape is still open.

## Why not type everything as exact interfaces?

Sometimes we should.

But some boundaries are genuinely dynamic:

- plugin outputs
- metadata patches
- notifier payload wrappers
- runtime args from CLI

The goal is balance:

```text
exact types where the shape is stable
shared generic types where the shape is intentionally flexible
```

## Where these types live

- `src/core/types/json.ts`
- `src/core/types/runtime.ts`
- `src/core/constants.ts` for shared runtime strings that must stay aligned

## Small visual example

```text
CLI arg or env var enters the system
            ↓
      RuntimeArgs / EnvMap
            ↓
 provider normalizes input
            ↓
      NormalizedRelease
            ↓
 plugins patch shared fields
            ↓
 final machine-readable result
```

## Rule of thumb

If you find yourself writing one of these repeatedly:

```text
Record<string, string>
Record<string, string | undefined>
Record<string, unknown>
```

pause and ask:

```text
Is there already a shared boundary type for this?
```

If yes, use it.

If no, consider whether adding one would make the code clearer for future readers.
