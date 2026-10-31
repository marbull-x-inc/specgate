# Contributing

Thanks for your interest. specgate is small on purpose; the bar for a change is "does this make
the gate stricter, faster or clearer without teaching the core about one company's conventions".

## Ground rules

- **The core stays generic.** No tracker ids, layer names, test-title prefixes or runner
  specifics in `src/`. Those belong in presets and config. The example under `examples/shop` is
  deliberately unlike any particular company's repository; if a change only works there, it is
  a preset, not a core feature.
- **Deterministic.** `scaffold`, `gen`, `check` and `docs` must produce the same output for the
  same input. No network, no clocks except where the test injects one.
- **No type assertions.** `as` (other than `as const`), `any` and non-null `!` are not used in
  `src/`. Narrow with type guards or Zod.
- **Tests live in `tests/`**, mirroring `src/`. Unit tests under `tests/unit`, end-to-end flows
  under `tests/integration`.

## Workflow

```bash
bun install
bun run verify          # lint + typecheck + test + build, what CI runs
bun run example:refresh # after a change to scaffold / gen / docs output
bun run schema:emit     # after a change to src/ir/schema.ts
```

1. Open an issue first for anything beyond a bug fix, so we can agree on the shape.
2. Fork, branch, commit in English. Commit messages follow `type: summary`
   (`feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`).
3. Add or update tests. If `gen` or `docs` output changes, run `bun run example:refresh` and
   commit `examples/shop-expected`; the integration test fails otherwise.
4. Open a pull request. CI must be green; the `main` branch requires squash merges and signed
   commits on the merge (GitHub signs squash merges).

## Releasing (maintainers)

`bun run version:patch|minor|major` bumps `package.json` and tags; `git push --follow-tags`
triggers `.github/workflows/release.yml`, which publishes to npm with provenance and creates the
GitHub Release.

## Security

See [SECURITY.md](SECURITY.md). Please do not file security problems as public issues.
