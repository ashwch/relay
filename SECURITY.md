# Security Policy

## Current status

This repository is currently private.

The security process below is intentionally written in a public-ready shape so
we do not have to invent it during a release or incident.

## What to report

Please report issues such as:

- leaked secrets or unsafe secret handling
- GitHub token permission problems
- release-record spoofing or tag-target confusion
- plugin loading bypasses
- unsafe external plugin execution
- notification payloads that expose sensitive data
- dependency vulnerabilities that affect release finalization

## What not to report here

Do not use public issues for sensitive reports if this repository becomes
public. Security reports should go through the private security contact listed
below.

## Reporting process

While the repo is private:

1. Contact the project maintainers through the internal security channel.
2. Include reproduction steps and affected files when possible.
3. Do not share exploit details outside the maintainer group until the issue is
   fixed or explicitly cleared.

Before making this repository public, replace this section with a public security
contact such as:

```text
security@example.org
```

## Release-framework-specific concerns

This project sits at a sensitive boundary:

```text
CI credentials
  ↓
release record mutation
  ↓
artifact/package visibility
  ↓
notifications
```

Security-sensitive code should follow these rules:

- keep GitHub Release idempotency anchored on repository + tag
- verify existing tags point at the expected commit
- pass secrets through `request.secrets`, not direct plugin environment reads
- never write secret values into normalized release JSON or delivery metadata
- keep external plugin refs explicit and allowlisted
- fail closed when release identity is ambiguous

## Supported versions

Until the project has a public release line, only the current private development
branch is supported.
