# 0003 — Reading a mutation report

Status: accepted · Issue: #32 · Follows: 0002 (phase 1)

## Problem

The phase 1 rules (`decision-untested`, `test-tautology`) work from literals. They miss a value a
test reaches indirectly (a route lookup, a fixture in another file), and every change that is not
a value: `.min(1)` → `.max(1)`, a flipped condition, a reordered route. In the pilot of 0002,
Stryker found 76 of 89 surviving mutants that specgate did not point at.

## Decision

specgate still never runs tests or mutants. It reads a report that another tool wrote in the same
CI job, in the
[mutation-testing-report-schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema)
(versions 1–3).

### Config

- `mutation.report`: path relative to `root`. Unset means the rules are off.
- `mutation.detected`: statuses that count as caught. Default `Killed`, `Timeout`,
  `RuntimeError`, `CompileError`. `Survived` and `NoCoverage` are counted as such, every other
  status (`Ignored`, `Pending`, a status from a later schema) as `ignored`.

### Reading

Validation is hand-written, like the config's. The issue proposed Zod, but Zod is a
development-only dependency here (it emits the IR schema) and the published package keeps no
schema library at run time. A mutant needs `id` (string or number), `mutatorName`, `status` and
`location.start.line`; `replacement` is optional (it is required only in v1). A path in `files`
resolves against `projectRoot` when the report gives one, otherwise against `root`.

A missing file, invalid JSON or a value that is not a report gives one
`mutation-report-unreadable` (warn) finding, and the other mutation rules do not run.

### Mapping

A mutant (by file and line range) belongs to:

1. **body**: the innermost function or method unit whose lines contain it
2. **helper**: every unit whose `helperRanges` contain it. `Unit.helperRanges` (new) lists the
   private helpers and same-module functions the decision walk followed from the unit
3. **collection**: every unit with a `member` decision on the collection whose declaration
   contains it. `Decision.collection` gains `line` / `endLine` for this

Mutants that belong to no unit are dropped. `Unit.mutation { killed, survived, noCoverage,
ignored }` counts every mutant the unit has, in any of the three places.

### Rules

| Rule                         | Default | Meaning                                                                                                            |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `mutant-survived`            | warn    | One finding per mutant the tests let through, on the first unit it belongs to (body, then helper, then collection) |
| `unit-not-executed`          | warn    | The unit has linked tests, and every counted mutant in its own lines is `NoCoverage`                               |
| `mutation-report-unreadable` | warn    | The report could not be used                                                                                       |

`Finding.mutant { id, mutator, replacement, status, line }` carries the mutant. The message names
the decision on the mutated line (`the boundary "18"`, or `membership in DENIED` on the line that
probes a collection), the collection a mutant changed, a helper, and the other units that reach it.

## Changes from the issue

- **`NoCoverage` in a unit the tests do run is reported** by `mutant-survived` ("is not run by
  any test"). A branch no test reaches is a hole as much as a survivor is. It is not reported
  when the whole unit is unexecuted (`unit-not-executed` says that once) or when the unit has no
  linked test (`guarantee-no-test` already does).
- **No dedicated fingerprint.** The accepted-findings fingerprint already leaves the line out and
  keeps the unit and the message, which holds the mutator and the replacement. Two identical
  mutants in one unit share it, so accepting one accepts both.

## Non-goals and limits

- Freshness. specgate does not compare the report with the sources. A report older than the code
  maps mutants to the wrong lines. Produce it in the same job, before `check`.
- Mutants in code no unit reaches (module top level, an exported helper that is not a surface
  unit) are not reported.
- A type or entry unit has no mutants.
