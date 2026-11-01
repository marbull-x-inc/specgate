# Configuration reference

`specgate.config.ts` default-exports `defineConfig({...})`. Presets are partial configs merged
first; the repo's own values win. Objects are merged, arrays are replaced. Every option below is
validated at load time with a clear error naming the offending path (`src/config/schema.ts` is the
source of truth).

```ts
import { dddTs, defineConfig } from "@marbull-x-inc/specgate";
export default defineConfig({ presets: [dddTs] /* overrides */ });
```

## Top level

| Option     | Default           | Meaning                                                                                                                                                                       |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`     | `"."`             | Repository root, relative to the config file.                                                                                                                                 |
| `tsconfig` | `"tsconfig.json"` | Program options come from here. Surface and test files are added as root files even when the tsconfig does not include them. Without a tsconfig a permissive default is used. |
| `mode`     | `"advisory"`      | `"advisory"` always exits 0; `"blocking"` exits 1 on any `fail` finding. `check --strict` behaves like blocking for one run.                                                  |
| `rules`    | `{}`              | Severity per rule id: `"fail"`, `"warn"`, `"info"`, `"off"`. Unlisted rules keep their default (see README).                                                                  |

## `surface`

| Option             | Default                                         | Meaning                                                                                                                                                       |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`          | `["src/**/*.ts"]`                               | Globs of files whose exports may be units.                                                                                                                    |
| `exclude`          | `["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"]` | Globs removed from `include`.                                                                                                                                 |
| `mode`             | `"referenced"`                                  | `"referenced"`: an export is a unit only when a non-test module imports it (named import, namespace import, re-export). `"exported"`: every export is a unit. |
| `classPattern`     | unset                                           | Regular expression; only classes whose name matches contribute methods (for example `"UseCase$                                                                | Service$"`). Unset means every exported class. |
| `operationPattern` | unset                                           | Regular expression on the operation name (method or function). Lets a repository adopt one operation at a time, even with `mode: "blocking"`.                 |

Units are: exported functions (declarations and arrow/function expressions), public methods of
exported classes (static or instance; `private` / `protected` / `#name` excluded), and exported
interfaces marked `@port`. Classes marked `@entity` become vocabulary instead.

## `tests`

| Option                                        | Default                                                   | Meaning                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`                                     | `["tests/**/*.test.ts", "**/*.test.ts", "**/*.spec.ts"]`  | Test files to read. Also excluded from counting as referrers in `surface.mode: "referenced"`.                                                                                                                                                                                            |
| `adapter`                                     | `"vitest"`                                                | `"bun"`, `"vitest"`, `"jest"` or `"playwright"`. Affects what `gen` emits (imports, `test.describe`, `fixme`) and `test.describe` recognition.                                                                                                                                           |
| `mirror.from` / `mirror.to` / `mirror.suffix` | `"src"` / `"tests"` / `".test.ts"`                        | `src/a/b.ts` → `tests/a/b.test.ts`. Files outside `from` keep their full path under `to`.                                                                                                                                                                                                |
| `describeOperationPatterns`                   | `["^method (\\w+)\\(\\)$", "^(\\w+)\\(\\)$", "^(\\w+)$"]` | Regular expressions whose first group names the operation when a `describe` title is used to complete a bare `<id>` title. The target (class) is the first `describe` title that is a plain identifier.                                                                                  |
| `prefixes`                                    | `{}`                                                      | Category prefix per guarantee kind, e.g. `{ ok: "正常系:", err: "異常系:" }`. `gen` writes it **before** the key (`正常系: Quest#create.ok.recorded …`) and linking strips any configured prefix before reading the key, so a repository rule that wants the prefix first keeps working. |
| `importExtension`                             | `""`                                                      | Extension `gen` writes on relative imports: `""`, `".ts"` (Bun, `allowImportingTsExtensions`) or `".js"` (NodeNext).                                                                                                                                                                     |
| `generatedSuffixes`                           | `[".doctest.test.ts", ".property.test.ts"]`               | Files `gen` owns completely. They are rewritten every run and never linked to guarantees.                                                                                                                                                                                                |
| `lineWidth`                                   | `120`                                                     | `gen` wraps a `test.todo(...)` line that would exceed this width the way common formatters do. Other generated lines may still need the project formatter.                                                                                                                               |

## `ids`

| Option        | Default                                                               | Meaning                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pattern`     | `^(ok\|err\|atomic\|frame\|idempotent)(\.[a-z0-9]+(?:-[a-z0-9]+)*)*$` | What a guarantee id may look like. The first segment is the _kind_ and drives `prefixes` and `gen`'s automatic branches. Use `^G[1-9]\d*$` for numbered ids. |
| `placeholder` | `"TODO"`                                                              | The id `scaffold` writes; `check` reports it with `guarantee-placeholder`.                                                                                   |

## `output`

| Option     | Default             | Meaning                                                                                                                             |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `dir`      | `".specgate"`       | Where `check` writes `report.json`, `summary.md`, `report.sarif`.                                                                   |
| `docsDir`  | `"docs/spec"`       | Where `docs` writes Markdown.                                                                                                       |
| `baseline` | `<dir>/report.json` | Previous report used for change detection (`guarantee-changed-test-unchanged`, `impl-changed-spec-unchanged`, `operation-removed`). |

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
