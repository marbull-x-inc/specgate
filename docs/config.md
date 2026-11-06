# Configuration reference

`specgate.config.ts` default-exports `defineConfig({...})`. Presets are partial configs merged
first; the repo's own values win. Objects are merged, arrays are replaced. Every option below is
validated at load time with a clear error naming the offending path (`src/config/schema.ts` is the
source of truth).

```ts
import { dddTs, defineConfig } from "@marbull-x-inc/specgate";
export default defineConfig({ presets: [dddTs] /* overrides */ });
```

`specgate.config.json` takes the same shape; a built-in preset is named by string:

```json
{ "presets": ["ddd-ts"], "surface": { "include": ["src/**/*.ts"] } }
```

## Top level

| Option     | Default           | Meaning                                                                                                                                                                       |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`     | `"."`             | Repository root, relative to the config file.                                                                                                                                 |
| `tsconfig` | `"tsconfig.json"` | Program options come from here. Surface and test files are added as root files even when the tsconfig does not include them. Without a tsconfig a permissive default is used. |
| `mode`     | `"advisory"`      | `"advisory"` always exits 0; `"blocking"` exits 1 on any `fail` finding. `check --strict` behaves like blocking for one run.                                                  |
| `rules`    | `{}`              | Severity per rule id: `"fail"`, `"warn"`, `"info"`, `"off"`. Unlisted rules keep their default (see README).                                                                  |

## `surface`

| Option             | Default                                         | Meaning                                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `include`          | `["src/**/*.ts"]`                               | Globs of files whose exports may be units.                                                                                                                                                                                                                                                 |
| `exclude`          | `["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"]` | Globs removed from `include`.                                                                                                                                                                                                                                                              |
| `mode`             | `"referenced"`                                  | `"referenced"`: an export is a unit only when a non-test module imports it (named import, namespace import, re-export). A module is a test when it is in `tests.include` or is shaped like one (`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`). `"exported"`: every export is a unit. |
| `classPattern`     | unset                                           | Regular expression; only classes whose name matches contribute methods (for example `"UseCase$                                                                                                                                                                                             | Service$"`). Unset means every exported class. |
| `operationPattern` | unset                                           | Regular expression on the operation name (method or function). Lets a repository adopt one operation at a time, even with `mode: "blocking"`.                                                                                                                                              |
| `entries`          | `{}`                                            | `package.json#exports` subpath → source module (`{ "./runtime": "src/runtime/index.ts" }`), for entries whose targets are build output only. Mapped subpaths are read from a condition that points to a `.ts` source under `root` without this.                                            |

Units are also: exported type aliases and non-`@port` interfaces whose doc has `@guarantee` (`type`), and the `@packageDocumentation` comment of each `package.json#exports` entry module (`entry`, id `entry#main` / `entry#<subpath>`); see the README section on types and package entries.

Units are: exported functions (declarations, arrow/function expressions, and constants whose
value is callable, such as `export const defu = createDefu()`; when such a constant only renames a
function of the same module, `export const persist = persistImpl as unknown as Persist`, that
function's body is the unit's for decisions and mutants; a declaration exported only as the
module's default, `const useCounter = …; export default useCounter` or `export default function
useBoolean`, is a unit under its declared name), public methods of exported
classes (static or instance; `private` / `protected` / `#name` excluded), and exported
interfaces marked `@port`. Overload signatures and their implementation are one unit; a
`@guarantee` on any of the signatures belongs to it. Classes marked `@entity` become vocabulary
instead. A `@guarantee` anywhere else is reported by `guarantee-on-non-unit`.

## `tests`

| Option                                        | Default                                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`                                     | `["tests/**/*.test.ts", "**/*.test.ts", "**/*.spec.ts"]`  | Test files to read. Also excluded from counting as referrers in `surface.mode: "referenced"`.                                                                                                                                                                                                                                                                                                         |
| `adapter`                                     | `"vitest"`                                                | `"bun"`, `"vitest"`, `"jest"` or `"playwright"`. Affects what `gen` emits (imports, `test.describe`, `fixme`) and `test.describe` recognition.                                                                                                                                                                                                                                                        |
| `mirror.from` / `mirror.to` / `mirror.suffix` | `"src"` / `"tests"` / `".test.ts"`                        | `src/a/b.ts` → `tests/a/b.test.ts`. Files outside `from` keep their full path under `to`.                                                                                                                                                                                                                                                                                                             |
| `describeOperationPatterns`                   | `["^method (\\w+)\\(\\)$", "^(\\w+)\\(\\)$", "^(\\w+)$"]` | Regular expressions whose first group names the operation when a `describe` title is used to complete a bare `<id>` title. The target (class) is the first `describe` title that is a plain identifier; when the test title names its operation (`isPosition.ok.x`), that title is the target only if the surface has such a target (a class or port).                                                |
| `prefixes`                                    | `{}`                                                      | Category prefix per guarantee kind, e.g. `{ ok: "正常系:", err: "異常系:" }`. `gen` writes it **before** the key (`正常系: Quest#create.ok.recorded …`) and linking strips any configured prefix before reading the key, so a repository rule that wants the prefix first keeps working.                                                                                                              |
| `importExtension`                             | `""`                                                      | Extension `gen` writes on relative imports: `""`, `".ts"` (Bun, `allowImportingTsExtensions`) or `".js"` (NodeNext).                                                                                                                                                                                                                                                                                  |
| `generatedSuffixes`                           | `[".doctest.test.ts", ".property.test.ts"]`               | Files `gen` owns completely. They are rewritten every run and never linked to guarantees.                                                                                                                                                                                                                                                                                                             |
| `lineWidth`                                   | `120`                                                     | `gen` wraps a `test.todo(...)` line that would exceed this width the way common formatters do. Other generated lines may still need the project formatter.                                                                                                                                                                                                                                            |
| `quote`                                       | `"auto"`                                                  | Quote style of generated string literals: `"double"`, `"single"`, or `"auto"`, which reads Biome `javascript.formatter.quoteStyle` (`biome.json` / `biome.jsonc`) or Prettier `singleQuote` (`.prettierrc`, `.prettierrc.json`, `package.json#prettier`) in `root` and falls back to double. Only generated text is re-quoted.                                                                        |
| `titleLength`                                 | `100`                                                     | Longest generated test title. The prefix and key stay whole; the statement is cut at a word with "…" and written in full as a comment above the test. `0` never cuts. Linking reads only the key.                                                                                                                                                                                                     |
| `titlePrefixes`                               | `[]`                                                      | More prefixes stripped from a title before the key is read, for categories `gen` should not write (for example `["異常系:"]` when `prefixes.err` is `"準正常系:"`). Matching only.                                                                                                                                                                                                                    |
| `prefixRules`                                 | `[]`                                                      | `[{ id, throws?, prefix }]`, tried in order before `prefixes[kind]` when `gen` writes a title: the first rule whose `id` regular expression matches the guarantee id (and `throws`, if given, its error type) gives the prefix. Use it when a kind splits into categories, such as 4xx and 5xx errors.                                                                                                |
| `arrange`                                     | unset                                                     | `{ sut?, port?, imports? }` templates for projects whose tests take the unit and its dependencies from a container. `sut` replaces `new Target(ports…)`; `port` replaces each port's stub; placeholders `{Target}`, `{operation}`, `{Port}`, `{member}`; `imports` are added as written. With `port` set, the frame, atomic and idempotent skeletons (which need recording stubs) become `test.todo`. |
| `literalLimit`                                | `1000`                                                    | Most literal values recorded per test (`TestCase.literals`), which `decision-untested` and the `decision-unspecified` downgrade read.                                                                                                                                                                                                                                                                 |

## `ids`

| Option         | Default                                                               | Meaning                                                                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pattern`      | `^(ok\|err\|atomic\|frame\|idempotent)(\.[a-z0-9]+(?:-[a-z0-9]+)*)*$` | What a guarantee id may look like. The first segment is the _kind_ and drives `prefixes` and `gen`'s automatic branches. Use `^G[1-9]\d*$` for numbered ids.                                                                                                                                         |
| `placeholder`  | `"TODO"`                                                              | The id `scaffold` writes; `check` reports it with `guarantee-placeholder`.                                                                                                                                                                                                                           |
| `deriveThrows` | `true`                                                                | Give `@throws` written without an id one: `err.<error type in kebab case>` (`-2`, `-3`, … when repeated). The type is the leading `{@link X}`, a leading error-shaped word or code span, else `Error`. Off, or when the derived id does not match `pattern`, the old `guarantee-id-invalid` applies. |

## `tsdoc`

| Option  | Default | Meaning                                                                                                                                                                                                      |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jsdoc` | `false` | Accept JSDoc conventions silently: undefined block tags (`@name`, `@category`, `@summary`), `{type}` and `[optional]` in `@param`, a missing hyphen, `{` in prose and examples. The content is still parsed. |

## `output`

| Option     | Default                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir`      | `".specgate"`              | Where `check` writes `report.json`, `summary.md`, `report.sarif`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docsDir`  | `"docs/spec"`              | Where `docs` writes Markdown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `baseline` | `<dir>/report.json`        | Previous report used for change detection (`guarantee-changed-test-unchanged`, `impl-changed-spec-unchanged`, `operation-removed`). Each report records the commit `.git` points to (`revision`) and a hash of the resolved config (`configHash`). When the default `<dir>/report.json` was written on another revision or under another config, it may come from another branch: the change-detection findings are one step lower and `baseline-stale` (info) names both. A baseline set here or passed with `--baseline` is compared as is. |
| `accepted` | `"specgate.accepted.json"` | Findings accepted at adoption, written by `check --accept-baseline` and meant to be committed. Matching findings are reported as `info` with `accepted: true`. For one reviewed finding, prefer an `@acceptFinding <rule-id> <value> <reason>` tag on the unit (see the README); `--accept-baseline` does not record findings a tag accepts.                                                                                                                                                                                                  |

## `provenance`

| Option      | Default                | Meaning                                                                                                               |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`   | `true`                 | Record per guarantee the introducing commit (`git log -S`) and last change (`git blame`). Off outside a git checkout. |
| `prPattern` | `"\\(#(\\d+)\\)\\s*$"` | Regular expression applied to the commit subject; group 1 is the PR id (opaque to the tool).                          |

## `requirementHeader`

| Option    | Default                                        | Meaning                                                                                                                                          |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled` | `false`                                        | Read opaque frozen-requirement ids from the first 2000 characters of each test file into `tests[].requirementIds`. Nothing else interprets them. |
| `pattern` | `"^\\s*(?:\\*\|//)\\s*@requirement\\s+(\\S+)"` | Line pattern; group 1 is the id.                                                                                                                 |

## `envInputs`

| Option   | Default                                                           | Meaning                                                                                                                   |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `forbid` | `["Date.now", "new Date", "Math.random", "fetch", "process.env"]` | Expressions reported by `env-input-direct` when they appear in a unit's body (including private helpers reached from it). |

## `decisions`

| Option            | Default | Meaning                                                                                                                                                                                                                            |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore`          | `[]`    | Values (`"1000"`, `"__proto__"`) or constant names (`"RETRY_LIMIT"`) that `decision-unspecified` treats as named and `decision-untested` does not ask the tests for. Use it for values you deliberately leave out of the contract. |
| `collectionLimit` | `500`   | Most `member` decisions recorded per collection. Beyond it, `decision-collection-truncated` reports the collection once. A collection name in `ignore` skips it entirely (generated route manifests, for example).                 |
| `widen`           | `false` | Record the decisions listed under "Widened walk" below as well. It raises the static `decision-*` count; with a value-mutant report loaded, the decisions its killed mutants confirm are not reported (see `mutation`).            |

A decision counts as named when a guarantee or `@example` of the unit, or of a surface unit that
calls it, contains one of its values (numbers compared by value, so `86_400_000` and `8.64e7`
count; strings with no letter directly before or after them, a plural `s` allowed) or its
constant name in a code span (names of three characters or more). `0`, `1`, `-1`, empty strings,
`typeof` checks, thrown error messages, strings in type positions (`as T<O["normalize"]>`), the
replacement pattern of `replace` / `replaceAll`, and arithmetic that only computes an array index
(`out[i * 2 + 2]`) are never decisions.

A `member` decision is one element of a module-level collection the unit tests membership in
(`includes`, `has`, `in`, `some((p) => v.startsWith(p))`, …), or of an array literal probed in
place (`["self", "src"].includes(item)`, collection `inline list at line N`). It is named when the
guarantee names the collection in a code span. Members the contract never names are reported once per
collection, not per element.

**Widened walk (`widen: true`, #61).** These sites also become decisions:

- the default of a parameter or of a destructured parameter (`initialValue = 0`,
  `{ delta = 1 }`): `constant`, `0`, `1` and `-1` included
- a number added to or subtracted from a parameter of the unit or of a helper it reaches
  (`boundaries + 1`), and a number passed to `Math.max` / `Math.min` (`Math.max(0, …)`):
  `boundary`, `0`, `1` and `-1` included. A callback's parameter does not count, and arithmetic
  that only computes an array index is still skipped.
- a local `const` or a parameter default that holds a module collection
  (`const s = separators ?? STR_SPLITTERS; s.includes(c)`): probed as that collection, one
  `member` per element
- each word of a regex group of plain words (`/^(a|an|the)$/i`, inline or in a module `const`):
  one `member` per word, probe `exact`, collection `regex at line N` or the constant's name
- a literal argument of `new X(…)` (`new Uint8Array(16)`) or a literal property of an object
  passed to it (`new Response(msg, { status: 413 })`), and a literal argument of a call on a
  parameter or an injected port (`c.res.headers.delete("Content-Length")`,
  `this.store.save("entry", 3600)`): `output`. Error and exception constructors are skipped.

Elsewhere `0`, `1` and `-1` stay excluded.

A decision counts as used by a test when a test linked to the unit, or to a surface unit that
calls it, writes the value as a literal in its body, its `each` table or a module-level `const`
of the same test file that they reference: numbers by value (a `boundary` also by value ± 1), an
`output` inside a longer string, a `member` the way the unit probes it (a prefix list is pinned
by a longer path that starts with the element), anything else by equality. A `match` on a word
also counts as used when one of the unit's own linked tests (not a caller's) writes a quantity
with it as the unit, `"10 years"` for `case "years":`.

## `mutation`

| Option      | Default                                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `report`    | unset                                                   | Mutation-testing-report-schema JSON (versions 1–3, Stryker's `mutation.json`) another tool wrote, relative to `root`, or a list of them read together (Stryker's report and a value-mutant report). Each path that cannot be used gives its own `mutation-report-unreadable`. Unset turns `mutant-survived`, `unit-not-executed` and `mutation-report-unreadable` off. Paths in the report resolve against its `projectRoot`, else `root`. |
| `detected`  | `["Killed", "Timeout", "RuntimeError", "CompileError"]` | Statuses that count as caught by the tests (`units[].mutation.killed`). `Survived` and `NoCoverage` count as such; every other status is `ignored`.                                                                                                                                                                                                                                                                                        |
| `findings`  | `"mutant"`                                              | `"mutant"`: one `mutant-survived` per mutant the tests let through. `"unit"`: one per unit, with the counts and up to `listLimit` survivors by line, each with the decision it changed.                                                                                                                                                                                                                                                    |
| `listLimit` | `5`                                                     | Survivors listed in a per-unit finding (`findings: "unit"`).                                                                                                                                                                                                                                                                                                                                                                               |
| `exclude`   | `[]`                                                    | Unit ids or file globs whose mutants are counted in `units[].mutation` but give no `mutant-survived` / `unit-not-executed`. Use it for code that tests outside this config exercise.                                                                                                                                                                                                                                                       |

## `resolve`

| Option              | Default | Meaning                                                                                                                                                         |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore`            | `[]`    | Tokens never reported as unresolved.                                                                                                                            |
| `allowProgramTypes` | `true`  | Accept PascalCase and SCREAMING_CASE tokens that name a class, interface, type alias, enum, enum member or string-literal union member anywhere in the program. |

## Presets

`dddTs` (`import { dddTs } from "@marbull-x-inc/specgate"`): application and domain directories as the
surface (`src/{application,domain}/**`, `packages/{application,domain}/src/**`), DTOs and
barrels excluded, tests mirrored to `tests/unit`, environment inputs extended with
`crypto.randomUUID`. A preset is just an object; write your own and pass it in `presets`.
