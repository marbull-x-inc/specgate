# Security Policy

## Supported versions

Only the latest published minor version receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). You will get an acknowledgement within 5 business
days and a fix or mitigation plan within 30 days for confirmed issues.

## What specgate does and does not do

specgate reads TypeScript sources, test files and git history in the repository it is run on,
and writes files under the configured output directory (`.specgate/`, `docs/spec/` and the test
mirror path). It makes no network requests. `specgate.config.ts` is executed as code, the same
way a bundler executes its config; treat it like any other file in your repository.

## Supply chain

- Releases are published from GitHub Actions with npm provenance (`--provenance`) via npm
  Trusted Publishing; no long-lived npm token is stored.
- Dependencies are pinned through `bun.lock` and updated by Dependabot.
- CodeQL and secret scanning run on every push and pull request.
