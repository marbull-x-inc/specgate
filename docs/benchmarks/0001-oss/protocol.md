# Benchmark 0001 — specgate 0.5.0 and Stryker on public TypeScript projects

Status: pre-registered. This file is committed before any measurement. It is not edited after
results exist; any change goes to a dated **Deviations** section at the end, with the reason.

## Questions

1. **Precision.** When a static rule of specgate (`decision-untested`, `decision-unspecified`,
   `test-tautology`) reports a finding, how often is it a real hole in the tests?
2. **Unique contribution.** Which real holes does specgate find that no surviving or
   not-covered Stryker mutant expresses? Of what kind are they?
3. **The converse.** Which Stryker survivors do the static rules of specgate not point at?
4. **Explanation.** With `mutation.report` set, how many Stryker survivors does specgate attach
   to a unit and to a named decision?
5. **Applicability.** For each kind of project, how many public operations become units, how
   many decisions are extracted, and where does the extraction not fit?
6. **Cost.** How long does `specgate check` take compared with the Stryker run on the same scope?

Authoring effort for guarantees is not measured: the intended workflow has an AI agent write
them.

## Tools

- `@marbull-x-inc/specgate@0.5.0` from npm, installed into each scratch project. Never run from
  the source of this repository. specgate is not changed or tuned during the benchmark; bugs and
  false-positive patterns are logged as issue candidates in the report.
- `@stryker-mutator/core` and the runner matching the project (`@stryker-mutator/vitest-runner`
  or `@stryker-mutator/jest-runner`), latest from npm at the time of the run (10.1.1 when this
  protocol was written). Versions actually used are recorded in `data/<project>/versions.json`.
- Node 24, macOS, one machine. Hardware is recorded in the report.

## Project selection

Five or six projects, one per kind:

| Kind                                                   | Counted |
| ------------------------------------------------------ | ------- |
| pure logic or utility library                          | yes     |
| parsing or validation library                          | yes     |
| state, data-structure or result-type library           | yes     |
| React UI component or hooks library, Testing Library   | yes     |
| server, HTTP routing or middleware code                | yes     |
| CLI tool (optional)                                    | yes     |
| `vercel/ms` (calibration only)                         | no      |

Every project must meet all of:

- TypeScript source
- tests in vitest or jest that pass at the pinned commit
- small enough for Stryker to finish in reasonable time once `mutate` is scoped to the API that
  has guarantees (target: under 30 minutes per project on the benchmark machine)
- an OSI license among MIT, Apache-2.0, BSD-2/3-Clause
- actively maintained: a commit to the default branch in the 12 months before the run

`projects.md` records, before any tool is run on a project, the repository, the pinned commit
SHA, the license, the test runner, the scope (files and operations) and why it was picked.
Projects are cloned into a scratch directory outside this repository. Only the files listed
under **Deliverables** are committed here.

A project that fails a criterion after selection (tests red at the pin, Stryker cannot run, no
operation is extractable) stays in the report as a result, with the reason.

## Scope

For each project, the scope is a set of source files and, in them, the public operations its
public docs describe. The scope is chosen from the docs and the file layout (file names and
`export` lines), not from implementation bodies. The same scope is:

- `surface.include` for specgate
- `mutate` for Stryker

## Guarantees (blind)

Guarantees are written before reading any implementation body or test, and before running
either tool.

- **Allowed inputs:** the project's README and documentation files or site pages, its published
  type declarations (`.d.ts` from the npm package or from `tsc --emitDeclarationOnly`), which
  hold signatures and JSDoc but no bodies, and `export` lines found with `grep` to locate a
  declaration.
- **Not allowed:** implementation bodies, tests, the git history of either.
- Guarantees are written into a file `guarantees.json` (`{ file, symbol, tags[] }`) and inserted
  into the sources by a script (`scripts/insert-guarantees.mjs`), which places a TSDoc block
  above the declaration or merges `@guarantee` / `@throws` lines into an existing doc comment.
  The author does not edit the source files by hand.
- One statement per guarantee. Statements name the concrete values the docs name (numbers,
  strings, default options, the elements of documented lists). A value the docs do not name is
  not invented.
- Ids follow the default pattern (`ok.*`, `err.*`).
- The result is frozen as `patches/<project>-guarantees.patch` and committed before the tests
  are read.

## Linking tests (mechanical)

After the guarantee patch is committed, tests are read and linked by renaming titles only.

- A test is linked when its body calls an operation in scope. Its title gets the key
  `<operation>.<id> ` (functions) or `<Class>#<method>.<id> ` (methods) prepended; the original
  title follows unchanged. Template-literal and `each` titles get the key at the start of the
  literal.
- The key chosen is the guarantee whose statement the test's assertions check most directly. If
  no guarantee matches, the operation's first `ok.*` guarantee is used, so that every test that
  exercises an operation counts as linked (the same "every test linked" condition as the
  0002 prototype).
- A test that calls several operations in scope is linked to the one named by its title or its
  enclosing `describe`; else to the first one it calls.
- No test body changes. No test is added, removed, skipped or strengthened. The project's own
  test suite must stay green after renaming.
- The mapping (file, line, old title, key, reason) is recorded in `data/<project>/links.json`.
  The renames are frozen as `patches/<project>-links.patch`.

## Runs

Per project, in a clean clone at the pinned SHA with both patches applied:

1. `npm`/`pnpm`/`bun` install as the project documents; install specgate and Stryker as dev
   dependencies.
2. Run the project's tests once; they must pass.
3. **Stryker:** `mutate` = scope, `coverageAnalysis: "perTest"`, `reporters: ["json", "clear-text"]`,
   other options at defaults except what the runner needs to start (recorded in
   `stryker.config.json`). Wall-clock is measured with `/usr/bin/time`.
4. **specgate static:** `specgate check` with no `mutation.report`. Wall-clock: median of 3
   runs.
5. **specgate with report:** `specgate check` with `mutation.report` pointing at Stryker's
   `reports/mutation/mutation.json`.

specgate config per project: `surface.include` = scope, `surface.mode: "exported"`,
`tests.include` = the project's test globs, adapter matching the runner, `tsdoc.jsdoc: true`,
`provenance.enabled: false`, all rule severities at their defaults.

## Oracle

A **hole** is a concrete change to the implementation that keeps the project's own test suite
green.

Every finding of these rules is judged: `decision-untested`, `decision-unspecified`,
`test-tautology`, `mutant-survived`, `unit-not-executed`. The smallest change the finding
implies is made in a throwaway copy, and the project's tests are run:

| Finding                                 | Change made                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| boundary value `n`                      | the comparison flipped to its off-by-one (`<` ↔ `<=`, `>` ↔ `>=`) at that place                    |
| constant / number                       | the value changed to `n + 1` (or `n * 2` for a multiplier, `-n` for `0`-like signs)                 |
| string output / match                   | the literal changed by appending `_x`                                                               |
| member of a collection                  | the element deleted                                                                                 |
| `decision-unspecified` on a collection  | each element deleted, one at a time; the finding is a hole if any single deletion stays green       |
| `test-tautology`                        | one element deleted from the collection the test iterates                                           |
| `unit-not-executed`                     | the unit body replaced by `throw new Error("x")`                                                    |
| `mutant-survived`                       | the mutant itself; Stryker's run is the test run. Survived or NoCoverage means the tests stay green |

Verdicts:

- **real hole**: the tests stay green
- **pinned**: the tests fail
- **not applicable**: the change is equivalent (no observable behaviour changes) or unreachable,
  with the reason

Every Stryker mutant with status `Survived` or `NoCoverage` is a hole by definition. Each one is
inspected for equivalence and marked `equivalent` with a reason when no input can tell it apart.

Verdicts are written to `data/<project>/verdicts.json`.

## Metrics

1. **Precision of the static rules:** real holes ÷ judged findings, per rule and per project,
   with counts. Not-applicable findings are counted in the denominator and also reported
   separately.
2. **Unique contribution (headline):** real holes from the static rules that no `Survived` or
   `NoCoverage` Stryker mutant expresses. A mutant expresses a hole when it is on the same line
   and changes the same token in a way that changes the same behaviour: an operator mutant on the
   same comparison for a boundary; a `StringLiteral` mutant on the same literal for a string; a
   `StringLiteral` mutant on the same element, or an `ArrayDeclaration` mutant on the
   collection, for a member. Ambiguous cases are resolved in Stryker's favour. Broken down by:
   - an element removed from a collection
   - a value the contract does not name (`decision-unspecified`)
   - other
3. **The converse:** non-equivalent Stryker survivors (`Survived` + `NoCoverage`) that no static
   specgate finding points at (same line, same decision).
4. **Explanation coverage:** among non-equivalent Stryker survivors in scope, the share that
   specgate (with `mutation.report`) reports in a finding attached to a unit, and the share
   whose message names a decision.
5. **Applicability:** per project, public operations in scope, units extracted, units with
   guarantees, decisions extracted (by kind), and the kinds of code where no decision is
   extracted.
6. **Cost:** wall-clock of `specgate check` (static, median of 3) and of the Stryker run, same
   scope, same machine.

Totals exclude the calibration project. With five or six projects, no statistical inference is
made; the report gives counts and states that they do not generalise beyond these projects.

## Deliverables

`docs/benchmarks/0001-oss/`:

- `protocol.md` (this file), committed first
- `projects.md`: picks, SHAs, scopes, reasons
- `scripts/`: reproduce a run end to end
- `data/<project>/`: specgate `report.json` (static and with report), a Stryker
  `mutation.json` summary (every mutant with status, mutator, location, replacement), the
  oracle verdicts, the test links, tool versions and timings
- `patches/`: `<project>-guarantees.patch`, `<project>-links.patch`
- `report.md`: results per project and in total, the headline numbers, failures and limits, and
  issue candidates for specgate

No third-party source is committed beyond the patches.

## Deviations

### 1. Computed test titles (2026-11-06, before any measurement)

Four ufo tests take their title from a loop variable (`test(t.input.toString(), …)`), so there
is no literal to prefix. Their title expression was rewritten as a template literal that starts
with the key (`` test(`parseURL.ok.full ${t.input.toString()}`, …) ``). Only the title changes;
the body does not. The four are marked `computedTitle: true` in `data/ufo/links.json`.

### 2. Link keys without the kind segment (2026-11-06, during the runs)

The links produced for mantine and ahooks wrote keys as `useCounter.initial` instead of
`useCounter.ok.initial`. The first static `specgate check` on mantine reported 0 linked tests,
which exposed it. The keys were corrected mechanically (the guarantee chosen for each test is
unchanged), the titles re-applied, the patch regenerated, and every specgate run and the ahooks
Stryker run were repeated. Stryker's results do not depend on titles.

### 3. Stryker 8.7.1 for scule (2026-11-06, during the runs)

scule pins vitest 1.5.3. `@stryker-mutator/vitest-runner` 9 and 10 require vitest 2 or later and
fail to start (`this.ctx.provide is not a function`). scule uses Stryker 8.7.1, the last version
whose runner accepts vitest 1. All other projects use 10.1.1.

### 4. How the oracle runs the tests (2026-11-06, before judging any finding)

"The project's tests" is the test runner command Stryker drives (`vitest run` or `jest`, scoped as
in `projects.md`), not the project's full `test` script (lint, type check, coverage thresholds).
As Stryker does, the oracle inserts `// @ts-nocheck` into the changed file, so a type error is
not a failing test. Where the type checker would catch a change, the report says so. Sandboxes
left by failed Stryker starts (`.stryker-tmp/`) are excluded from the jest runs.

### 5. Runner harness settings (2026-11-06, during the runs)

Stryker's `plugins` lists the runner explicitly (pnpm's layout hides it from Stryker's plugin
discovery); jest runs with `watchman: false`; mantine's Stryker config ignores two symlinks that
point outside the repository (`CONTEXT.md`, `docs`). specgate 0.5.0 was published about 30
minutes before it was installed; ms's `minimumReleaseAge` setting was overridden for that install.
Some Stryker runs overlapped with a few one-second specgate runs on the same machine.
