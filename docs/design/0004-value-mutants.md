# 0004 — Value mutants

Status: proposed (on its branch until benchmark 0003 decides) · Issue: #60 · Follows: 0002, 0003

## Problem

Benchmark 0001 ran specgate 0.5.0 and Stryker on public TypeScript projects. The static rules of
0002 found 2 real holes, and a surviving Stryker mutant expressed both. As a hole finder, specgate
added nothing over Stryker there.

Stryker's operators leave out exactly the values a contract states. In the 1,497 mutants of that
benchmark, none changed a number literal, none changed a non-empty string into another non-empty
string (`StringLiteral` only empties it), and none removed one element of a list, one entry of an
object literal or one alternative of a regex group (`ArrayDeclaration` empties the whole list). A
PoC that made one such change at every value site of the same scopes and ran the tests found 27
real holes that no Stryker survivor expressed, 48 of its 57 green changes being real holes.

## Decision

specgate still never runs tests (0002, 0003). It decides **which** value changes to make and how
to report them. A runner outside the published package applies them, runs the tests, and writes
a mutation-testing-report-schema report. That report goes through 0003's path
(`mutation.report`, `mutant-survived`) with no new rule.

```
specgate mutants  →  .specgate/mutants.json  →  runner  →  value-report.json ┐
stryker run       →  reports/mutation/mutation.json ────────────────────────┴→ specgate check
```

### Sites

A **value site** is a literal in code a unit with guarantees owns, as the decision walk already
defines it:

- the unit's own lines (`Unit.line`–`Unit.endLine`), for function and method units
- the helpers it reaches (`Unit.helperRanges`)
- the module-level constants it reads (`Unit.constantRanges`, any module)
- the declarations of collections it has `member` decisions on (`Decision.collection`)

Units without guarantees, type units and entry units give no sites. A site inside several units'
code is listed once, on the unit 0003's mapping would report it on (body, then helper, then
collection, then constant).

### Changes

One mutant per change:

| `kind`        | Site                                                                                                    | Change                             |
| ------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `number`      | a number literal (decimal, hex, …; not a bigint)                                                        | `n` → `n + 1` (`-1` becomes `-2`)  |
| `string`      | a non-empty string literal or template without substitutions                                            | `"s"` → `"s_x"`                    |
| `element`     | one element of an array literal of two or more literals (strings, numbers, booleans, `null`)            | the element and its comma removed  |
| `entry`       | one single-line property of an object literal written in a module-level `const`, two or more properties | the property and its comma removed |
| `alternative` | one word of a regex group whose alternatives are plain words (`(a\|an\|the)`, `(?:x\|y)`)               | the word and one `\|` removed      |

An element of a literal list gets only the `element` change, not also `number` or `string`: for
a list the code tests membership in, the two are the same hole, and the removal is the one a
contract states ("the default splitters are …").

Skipped, as the decision walk already skips them:

- type positions (anything under a type node: literal types, `satisfies` types, generics)
- import and export specifiers, `import(…)` and `require(…)` arguments
- the string side of a `typeof` comparison, and `case` labels of `switch (typeof …)`
- thrown messages: anything inside a `throw` expression or in the arguments of
  `new …Error(…)` / `new …Exception(…)`
- property keys (`{ key: … }`, computed keys, method names), and the left side of `"k" in x`
- directive prologues (`"use strict"`, `"use client"`)
- arguments of `console.*` calls

Numbers stay `n + 1` only. `n - 1` and `0` would double the run time, and boundaries are already
mutated by Stryker's `EqualityOperator`.

### The contract: `.specgate/mutants.json`

`specgate mutants [--out <dir>]` writes `<out>/mutants.json` (default `output.dir`, `.specgate`).
It reads the same config as `check` and runs the same extraction; it never runs a test.

```json
{
  "schemaVersion": "1",
  "tool": { "name": "specgate", "version": "0.5.3" },
  "files": { "src/useCounter.ts": { "sha256": "…" } },
  "mutants": [
    {
      "id": "value-1",
      "unit": "useCounter",
      "file": "src/useCounter.ts",
      "line": 12,
      "column": 34,
      "endLine": 12,
      "endColumn": 35,
      "start": 311,
      "end": 312,
      "kind": "number",
      "original": "0",
      "replacement": "1",
      "description": "the default `initialValue` 0 → 1",
      "decision": { "kind": "constant", "values": ["0"] },
      "readers": [{ "file": "src/useCounter.ts", "line": 10, "endLine": 40 }]
    }
  ]
}
```

- `file` is relative to `root`, POSIX separators. `files[file].sha256` is the hash of the file's
  text when the list was made.
- `start` / `end` are offsets in UTF-16 code units into the file's text (the offsets TypeScript
  and JavaScript strings use). `original` is exactly `text.slice(start, end)`; `replacement` is
  the text that takes its place. For a removal, the span includes the separating comma or `|`,
  and `replacement` is `""`.
- `line` / `column` / `endLine` / `endColumn` are 1-based, as in the mutation-testing-report-schema,
  and only for reporting.
- `description` names the change in contract terms: `the default \`initialValue\` 0 → 1`,
`` `"."`removed from`STR_SPLITTERS` ``, `` `status: 413`removed from`DEFAULTS` ``,
`` `an`removed from the regex`/^(a|an|the)$/` ``.
- `decision` is the unit's decision on the same line whose values hold the original value, when
  there is one.
- `readers` is the code that runs the site, for test selection. For a site in a function, the
  lines (and followed helpers) of the units that own it. For a site in a module-level `const`,
  the outermost function around every reference to the constant in the program (any file, units
  with guarantees or not; references in type positions do not count; a reference in another
  module-level `const` is followed, three levels). Absent when some reference is outside any
  function (`export default X`, a module-level statement): then no reader set is complete.
  Each reader that has a name (a function declaration, a `const` holding a function) lists its
  `callers`, the same way and three levels deep; `callers` is absent when they cannot be traced
  (a method, a callback, a reference outside a function). The test files that name a reader or a
  caller are added to `tests`.
- `names` (module-level sites): the constants the site is written in. `tests`: test files (from
  `tests.include`) that reference the constant directly.
- Mutants are sorted by file and `start`; `id`s are `value-<n>` in that order. They are unique
  within one file, not stable across runs.

### The runner

The runner lives in `scripts/value-mutants/run.ts`, not in the package: it runs tests, which the
package never does. It takes the list, a test command and, optionally, a Stryker report:

```bash
node scripts/value-mutants/run.ts --mutants .specgate/mutants.json \
  --command "npx vitest run" --stryker reports/mutation/mutation.json \
  --out reports/mutation/value.json
```

For each mutant it:

1. checks that the file's hash matches `files[file].sha256` and that `original` is at
   `start`–`end`; otherwise the mutant is `Ignored` with the reason (the list is stale)
2. writes the file with `replacement` in the span and `// @ts-nocheck` prepended (as Stryker
   does, so a type error is not a failing test)
3. runs the test command; exit code 0 is `Survived`, any other `Killed`, past the timeout
   `Timeout`
4. restores the file, also on an interrupt

**Test selection.** With `--stryker`, the runner reads `coveredBy` from Stryker's report. The
tests of the innermost Stryker mutant whose location contains the site cover the site (a test
that reaches the site entered that mutant's code). Their test files are passed to the command
(`{files}` in the command, or appended). When that mutant covers no test, the value mutant is
`NoCoverage` without a run.

When no mutant contains the site or it is static (module-level code: Stryker does not track it per
test), the runner uses `readers`: the tests covering the non-static mutants inside each reader,
plus the `tests` that name the constant. A test that observes a module-level value either runs
code that reads it or reads it by name. Each reader must lie in a file of the Stryker report and
hold at least one non-static mutant with coverage, or, failing that (outside the report, or
marked static), reach such mutants through all of its `callers`; otherwise (or without `readers`,
or without `coveredBy`) the whole command runs. A test that runs a function either calls it by
name or runs one of its callers; calls through a method or a callback are not traced, which is
why such readers have no `callers`.

**Selection check and timeouts.** Each distinct selection runs once without any change; a
selection that fails falls back to the whole suite, and its run time sets the timeout of its
mutants as Stryker does: net time × 1.5 + 5 s (the whole suite's for whole-suite runs). A run that
times out while others share the machine is repeated alone. A test command should stop at the
first failure (`vitest --bail=1`, `jest --bail`), as Stryker does: a killed mutant then costs one
failing test file, not the suite. Added after benchmark 0003's first measurement, where
es-toolkit ran 89 of 113 value mutants against its whole suite (deviation 10).

**Concurrency.** `--concurrency <n>` runs `n` sandboxes, copies of the project without
`node_modules` (symlinked) and `.git`, as Stryker does. The default is 1, in place.

**Output.** A mutation-testing-report-schema v2 report: `files[file].source` (the original text),
and per mutant `id`, `mutatorName: "Value"`, `replacement` (the `description`, so the finding and
an acceptance quote it), `location` (from the list), `status`, `statusReason` and, when tests were
selected, `coveredBy` (Stryker's test ids).

### Reading it back

- `mutation.report` accepts a string or a list of paths, so the value report and Stryker's report
  are read together. Each path that cannot be used gives its own `mutation-report-unreadable`;
  then, as in 0003, the other mutation rules do not run.
- `mutant-survived` for a `Value` mutant says what changed in contract terms:
  ``useCounter: the default `initialValue` 0 → 1 survived; no linked test fails when the code changes like this``.
- An equivalent value mutant is accepted with
  `@acceptFinding mutant-survived Value:"the default \`initialValue\` 0 → 1" <reason>`, as
Stryker's are, or with `check --accept-baseline`.

## Measurement before merge

The PoC's projects and the cases of #61 informed this design, so they do not decide the merge.
Benchmark 0003 (`docs/benchmarks/0003-value-mutants/`) runs on projects that took no part in it,
with 0001's protocol, and is committed before it runs. The merge criteria are #60's: real holes no
Stryker survivor expresses in more than half of the projects; at least 70% of green value mutants
real holes after the equivalence review; runner wall-clock with test selection at most 2×
Stryker's; no more static `decision-*` findings on 0001's projects than with 0.5.0.

## Non-goals and limits

- specgate does not run the runner, and `check` does not need it.
- The runner applies one change at a time. It does not schedule mutants by test cost.
- Freshness is checked per file by hash, in the runner; `check` does not compare a report with
  the sources (0003).
- Sites #61 adds to the decision walk (a list reached through a local, literal arguments of calls
  on a parameter) only appear once the walk records those ranges.
