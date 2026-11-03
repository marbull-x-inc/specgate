# 0001 — Guarantees on types and package entries

Status: proposed · Issue: #20 (item 3)

## Problem

Two kinds of promise have no unit to live on today. They are reported by
`guarantee-on-non-unit`, or authors move them onto an unrelated function.

| Promise                             | Example                                                                                                                      | Where it ended up in practice                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A type accepts or rejects something | defu: `Defu<{ a: number }, [{ a: string }]>` keeps `a: number`. ms: `ms("1 lightyear")` is a type error under `StringValue`. | On `createDefu` and on the `ms` overloads, as `ok.type.*` ids |
| A package entry exposes something   | defu: `import { defu } from "defu"` and `require("defu")` both work. ms: the package has a single `"."` entry.               | On `createDefu` / `ms`, as `ok.pkg.*` / `ok.module.*` ids     |

In two sandbox runs (vercel/ms, unjs/defu) the tests for these were hand-written. Both authors
independently built the same two helpers:

- **A type checker at test time.** None of the usual runners type-check:
  - ts-jest with `isolatedModules` does not.
  - bun does not.
  - vitest does only in `--typecheck` mode, on `*.test-d.ts` files.
    So `// @ts-expect-error` inside a test proves nothing at run time. Both authors called the TypeScript compiler API from the test and matched diagnostics.
- **An entry loader.** A child Node process imports and requires the package by its own name (self-reference) from the repository root, after a build.

## Decision

Add two unit kinds and two helpers. Linking stays as it is: a test names a key, nothing more.

### Unit kinds

|               | `type`                                                                           | `entry`                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared by   | An exported `type` alias or a non-`@port` `interface` whose doc has `@guarantee` | The `@packageDocumentation` comment of an entry module                                                                                                                           |
| Unit id       | The type name: `Defu`                                                            | `entry#<slug>`. The slug is `main` for `"."`, otherwise the subpath with `/` and `.` turned into `-`: `./runtime` → `entry#runtime`, `./presets/ddd-ts` → `entry#presets-ddd-ts` |
| Key           | `Defu.ok.left-wins`                                                              | `entry#runtime.ok.esm`                                                                                                                                                           |
| `ok.*` means  | The type expression in the statement compiles, and resolves as stated            | The entry resolves under the stated condition and exposes the stated names                                                                                                       |
| `err.*` means | The type expression in the statement is a type error                             | Resolution fails (for example, `require` of an ESM-only entry)                                                                                                                   |
| IR fields     | `typeText`, the declared type, for docs                                          | `entry: { subpath, source, conditions: Record<string, string> }`                                                                                                                 |

Choices behind the table:

- **The `entry#` prefix.** A package name such as `@scope/name` cannot appear in a key: titles split on `.` and the qualifier must be an identifier. A fixed `entry` target keeps every key valid and readable.
- **Which file is an entry.** It is resolved from `package.json#exports`:
  - A condition whose target is a source file under `root` wins: `bun`, `source`, `development` or `default`, if it points to `.ts`.
  - Otherwise `surface.entries` maps subpaths to files, for example `{ ".": "src/index.ts" }`.
  - When an export has neither, `entry-unmapped` (info) says so, and the entry gets no unit.
- **Where entry guarantees are written.** They go in `@packageDocumentation`, the standard TSDoc place for package-level docs. `package.json` cannot carry TSDoc.
- **The IR.** `UnitKind` gains `"type"` and `"entry"`. This is additive, so the IR `version` stays `"1"`. Consumers that switch on `kind` must handle the two new values. The release notes will say so.

### Helpers in a new subpath, `@marbull-x-inc/specgate/typecheck`

This is kept out of `/runtime` so that tests which never check types do not load TypeScript.

```ts
/** Type-checks `source` as a module next to `from` (paths and tsconfig as the repository's). */
export function checkTypes(
  source: string,
  options: { from: string; tsconfig?: string },
): {
  errors: Array<{ code: number; message: string; line: number }>;
};
```

```ts
/** Loads an entry of the package under test in a child Node process, after a build. */
export function loadEntry(
  subpath: string,
  options: { root: string; condition: "import" | "require" },
): { ok: true; exports: string[] } | { ok: false; error: string };
```

Their design points:

- **`checkTypes` reuses the program options.** It resolves the package's own name through `compilerOptions.paths` or self-reference, as the project does. specgate already depends on `typescript` at run time, so there is no new dependency.
- **`loadEntry` reads only names.** It spawns `node --input-type=module -e` (for `import`) or `node -e` (for `require`) with `cwd: root` and returns the export names. It never returns values, so nothing crosses the process boundary except JSON.

### What `gen` writes

Type guarantees go to `<mirror>.types.test.ts`, which every adapter runs:

```ts
import { checkTypes } from "@marbull-x-inc/specgate/typecheck";

test("Defu.ok.left-wins …", () => {
  // Defu<{ a: number }, [{ a: string }]> keeps a: number
  const { errors } = checkTypes(
    `import type { Defu } from "../src/types";
     // TODO: the type expression from the statement
     const check: Defu<{ a: number }, [{ a: string }]> = { a: 1 };`,
    { from: import.meta.url },
  );
  expect(errors).toEqual([]); // err.* guarantees: expect(errors.length).toBeGreaterThan(0)
});
```

Entry guarantees go to `<mirror>.entry.test.ts`, skipped until the author confirms the build step:

```ts
import { loadEntry } from "@marbull-x-inc/specgate/typecheck";

// Needs the package built (`npm run build`); un-skip once CI builds before testing.
test.skip("entry#main.ok.esm exposes defu", () => {
  const r = loadEntry(".", { root: process.cwd(), condition: "import" });
  expect(r).toMatchObject({ ok: true });
});
```

## What does not change

- **Rules.** `guarantee-no-test`, `test-orphan`, `identifier-unresolved` and change detection apply as for any unit. `decision-unspecified`, `env-input-direct` and `uses-mismatch` do not apply: these units have no body.
- **`guarantee-on-non-unit`.** It keeps firing for type aliases and interfaces that are not exported, and for an entry module that `package.json` does not export.

## Known limits

- **Entry tests read the build, not the sources.** A source change reaches them only after a rebuild, which is also why mutation testing cannot reach them.
- **`checkTypes` checks a snippet, not the whole project.** Errors elsewhere in the program do not leak in, but the snippet must import what it uses.
- **`typeText` is the declared text.** It is not the expanded type, so docs show `Defu<T, S>` rather than what it computes.

## Plan

1. `type` units, `checkTypes`, the `gen` skeleton, and docs.
2. `entry` units, `exports` resolution, `surface.entries`, `entry-unmapped`, `loadEntry`, and the skipped skeleton.
3. Release notes for the IR enum change, then 0.4.0.

## Alternatives not taken

- **Use vitest's `expectTypeOf`.** It only checks in vitest `--typecheck`. bun and jest users would get tests that pass without checking anything.
- **Generate a `tsd` / `*.test-d.ts` file and require a type-check step in CI.** This is honest, but the gate cannot see whether that step runs. A test that runs the checker itself is visible to `check` like any other test.
- **Put entry guarantees in `specgate.config`.** Configuration would then hold the specification. The contract belongs next to the code it describes, and `@packageDocumentation` is that place.
