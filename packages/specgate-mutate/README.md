# @marbull-x-inc/specgate-mutate

Runs [specgate](https://github.com/marbull-x-inc/specgate)'s **value mutants**: the value changes
Stryker never makes (a number `n` → `n + 1`, a string with a suffix, one element of a literal
list, one entry of a module-level object, one word of a regex group removed). specgate chooses
the changes and reads the results; it never runs a test. This package is the part that does.

```bash
npm install -D @marbull-x-inc/specgate @marbull-x-inc/specgate-mutate
```

## Use

```bash
npx stryker run                                   # optional: reports/mutation/mutation.json with coveredBy
npx specgate-mutate --command "npx vitest run --bail=1 {files}"
```

With no command name, `specgate-mutate` runs all three steps:

1. `specgate mutants` writes the value changes to `.specgate/mutants.json`.
2. For each change, the runner applies it to a copy of the project (with `// @ts-nocheck`
   prepended to the changed file), runs the test command and writes a
   mutation-testing-report-schema report to `reports/mutation/value.json`, `mutatorName: "Value"`.
3. `specgate check` reads that report. The specgate config must list it:

```ts
mutation: { report: ["reports/mutation/mutation.json", "reports/mutation/value.json"] },
```

`mutant-survived` then names each surviving change in contract terms, for example
`useCounter: the default \`initialValue\` 0 → 1 survived`.

| Command                   | Does                                      |
| ------------------------- | ----------------------------------------- |
| `specgate-mutate` / `all` | `list`, then `run`, then `specgate check` |
| `specgate-mutate list`    | `specgate mutants` only                   |
| `specgate-mutate run`     | the runner only, on an existing list      |

## Options

| Option          | Default                                         | Meaning                                                                                                                                                        |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--command`     | (required for `run`, `all`)                     | The test command. `{files}` is replaced by the selected test files, otherwise they are appended. Stop at the first failure (`vitest --bail=1`, `jest --bail`). |
| `--stryker`     | `reports/mutation/mutation.json` when it exists | A Stryker report with `coveredBy`, used to run only the tests that can reach each change.                                                                      |
| `--out`         | `reports/mutation/value.json`                   | The value report.                                                                                                                                              |
| `--mutants`     | `.specgate/mutants.json`                        | The change list.                                                                                                                                               |
| `--cwd`         | `.`                                             | Where the test command runs, relative to the root (a package of a monorepo).                                                                                   |
| `--concurrency` | logical cores − 1                               | Parallel runs, each in its own copy of the project (`node_modules` linked).                                                                                    |
| `--timeout-ms`  | from each selection's own time                  | A fixed timeout per run.                                                                                                                                       |
| `--only`        |                                                 | Comma-separated value-mutant ids (`run`).                                                                                                                      |
| `--config`      |                                                 | The specgate config (`list`, `all`).                                                                                                                           |
| `--specgate`    | the specgate installed in the project           | How to run specgate, for example `"bun x specgate"`.                                                                                                           |

## Test selection

Without a Stryker report every change runs the whole test command. With one, the runner runs only
the test files that can reach the change: those covering the innermost Stryker mutant around it;
for a module-level constant (which Stryker does not track per test), those covering the code that
reads it and the code that calls that, plus the test files that name it. When that cannot be told
(a method call, a callback), it runs the whole command. Each selection is run once without any
change first; one that fails falls back to the whole command. Details: specgate's
`docs/design/0004-value-mutants.md`.
