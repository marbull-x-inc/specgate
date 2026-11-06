# Benchmark 0003 — Value mutants on projects that took no part in the design

Status: pre-registered. This file is committed before any project is cloned, installed or run.
It is not edited after results exist; any change goes to a dated **Deviations** section at the
end, with the reason.

Issue: #60. Design: `docs/design/0004-value-mutants.md`. Protocol base: benchmark 0001
(`docs/benchmarks/0001-oss/protocol.md` on branch `feature/bench-oss-0001-e87ac9`). Where this
file says "as in 0001", 0001's rule applies unchanged.

## Why a new set of projects

The PoC of #60 ran on the six projects of benchmark 0001, and the list of sites in #61 was read
off their holes. Those projects informed the design, so they cannot judge it. The merge decision
is made on the projects below, which took no part in it. 0001's six projects are run as a
regression check only.

## Questions and merge criteria

The four criteria are #60's, fixed before the results:

| #   | Criterion                                                                                                                          | Holds when                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| C1  | Real holes that no `Survived` or `NoCoverage` Stryker mutant expresses                                                             | at least 1 in more than half of the new projects that ran     |
| C2  | Of the value mutants that keep the tests green, the share that are real holes after the equivalence review                         | at least 70%, over all new projects together                  |
| C3  | Runner wall-clock with `coveredBy` test selection, against Stryker's wall-clock on the same scope                                  | at most 2×, on the sum over the new projects that ran         |
| C4  | Static `decision-*` findings (`decision-unspecified`, `decision-untested`, `decision-collection-truncated`) on 0001's six projects | no project has more than with 0.5.0 (0001's recorded results) |

A project **ran** when the runner produced a report for it. Counts are reported, not only
percentages. Per-project values are reported for every criterion, and a project that would
fail a criterion on its own is named. If a criterion fails, the report says which and by how
much; the feature stays on its branch (or ships behind an `experimental` flag, decided with the
numbers in hand).

Also reported, not judged: value mutants per kind and status, the number of hole sites, which
holes are on a value a guarantee names (#62), and the wall-clock of `specgate mutants`.

## Tools

- specgate from this branch, run from source with Bun (`bun <repo>/src/cli.ts`), at the commit
  that adds this file. The value-mutant runner is `scripts/value-mutants/run.ts` from the same
  commit, run with Node 24.
- specgate's site selection and messages are not changed during the benchmark. A runner bug that
  stops a run (a crash, a file not restored, a wrong status from a harness problem) may be fixed;
  each fix is recorded under **Deviations** with the runs it affected, which are repeated.
- `@stryker-mutator/core` and the runner matching the project, 10.1.1 (latest on npm when this
  file was written), installed with lifecycle scripts off. A project whose test runner is older
  than Stryker 10's peer range uses the newest Stryker that accepts it, as 0001's deviation 3.
- Node 24, macOS, one machine (Apple M3 Max, 16 logical cores, 128 GB).

## Projects

From #60, picked by 0001's criteria (TypeScript; vitest or jest; MIT; a commit in the last 12
months; checked on 2026-11-06):

| Kind                 | Project                               | Commit (default branch, 2026-11-06)        | Tests                    |
| -------------------- | ------------------------------------- | ------------------------------------------ | ------------------------ |
| utility              | toss/es-toolkit                       | `4fb8c4e1e89c9009b887e5d917d65e42a9a16626` | vitest                   |
| utility              | unjs/defu                             | `82632b66f5914e9946edce300e10633a3d5c0cb7` | vitest                   |
| parsing / validation | fabian-hiller/valibot                 | `d72f76fcf70ccfa0a5ca341b80da1d440ac60b11` | vitest                   |
| parsing              | harrisiirak/cron-parser               | `ab3c04abb57d9c08646a96adf5b5e6c1422380ae` | jest                     |
| result type          | supermacro/neverthrow                 | `5ef3a018bda74fb960e44b68fc3672635ee8037d` | vitest                   |
| state                | pmndrs/jotai                          | `c4e3bc34c4e53fb331cfc68c94b2b7a8ad7aa465` | vitest + Testing Library |
| React hooks          | react-hook-form/react-hook-form       | `7e65ad5271daf8db8b123fdd0f8edad9d2b4416f` | jest + Testing Library   |
| React hooks          | JohannesKlauss/react-hotkeys-hook     | `0798c4eb1cedb1f868b7570d8e0cc163c5a01b51` | vitest + Testing Library |
| server               | unjs/h3                               | `f0e17808ac2439b6434bb10609a961067f4d555b` | vitest                   |
| server middleware    | express-rate-limit/express-rate-limit | `b0d0c1f7cfaf44b8c73d6f82cbff0ce09bb3dffb` | jest                     |
| CLI (optional)       | cacjs/cac                             | `12a5e8278719dfd9a4b7197a6690e7bf01b20b07` | vitest                   |

Each is cloned shallow at the commit, in a scratch directory outside this repository, and its
dependencies installed with its own package manager and lockfile, lifecycle scripts off. Its
tests must pass at the pin; a project that fails here, or later (Stryker cannot start, no unit
is extracted, the runner cannot run), stays in the report with the reason. The license and test
runner are confirmed from the clone and recorded in `projects.md`, with the scope and the docs
used, before Stryker or specgate runs on it.

The regression check uses 0001's six counted projects (scule, ufo, zustand, mantine hooks,
ahooks, hono) at 0001's pins with 0001's committed guarantee and link patches and configs.

## Scope (as in 0001)

Per project, a set of source files and, in them, the public operations its public docs
describe, chosen from the docs and the file layout (file names and `export` lines), not from
implementation bodies. The same scope is `surface.include` for specgate and `mutate` for
Stryker. For a large library (es-toolkit, valibot), the scope is a documented group of about
ten to twenty operations, picked from the docs' own grouping before any body is read.

## Guarantees (blind, as in 0001)

Allowed inputs: the README, documentation files or site pages, published type declarations, and
`export` lines located with `grep`. Not allowed: implementation bodies, tests, git history. One
statement per guarantee; statements name the values the docs name (numbers, strings, defaults,
the elements of documented lists); a value the docs do not name is not invented. Inserted by
0001's `insert-guarantees.mjs`; frozen as `patches/<project>-guarantees.patch` and committed
before any test is read.

The guarantees are written by an AI agent session given only the allowed inputs and these rules.
It has not seen the project's implementation or tests, nor this benchmark's results.

## Linking tests (mechanical, as in 0001)

After the guarantee patch is committed, tests are linked by renaming titles only, with 0001's
`apply-links.mjs`: a test whose body calls an operation in scope gets the key of the guarantee
its assertions check most directly, else the operation's first `ok.*` guarantee. No test body
changes; the suite stays green. Frozen as `patches/<project>-links.patch`; the mapping in
`data/<project>/links.json`.

## Runs

Per project, in the clone with both patches applied:

1. Run the test command once; it must pass.
2. **Stryker**: `mutate` = scope, `coverageAnalysis: "perTest"`, `reporters: ["json"]`, other
   options at their defaults except what the runner needs to start (recorded in
   `stryker.config.json`). Wall-clock measured by `/usr/bin/time -p`. The number of test runner
   processes Stryker starts is read from its log.
3. **specgate static**: `specgate check` with no `mutation.report`; config as in 0001
   (`surface.include` = scope, `surface.mode: "exported"`, the project's test globs and adapter,
   `tsdoc.jsdoc: true`, `provenance.enabled: false`, default severities).
4. **specgate mutants**: `specgate mutants` with the same config. Wall-clock recorded.
5. **Runner**: `run.ts --mutants .specgate/mutants.json --stryker <Stryker's mutation.json>
--command "<the test command Stryker drives>"`, with `--concurrency` equal to the number of
   test runner processes Stryker started, other options at their defaults. Wall-clock by
   `/usr/bin/time -p`. The test command takes the selected test files (`{files}` or appended).
6. **specgate with both reports**: `specgate check` with `mutation.report` listing Stryker's
   report and the runner's.

Regression check, per 0001 project: step 3 with this branch, against 0001's recorded
`specgate-static.json` (C4); steps 2, 4, 5 and 6 as above, reported as counts only (no
equivalence review).

## Oracle

A value mutant whose status is `Survived` or `NoCoverage` **keeps the tests green**; the runner's
run (or, for `NoCoverage`, the absence of any covering test in Stryker's per-test coverage) is
the test run. Each such mutant gets one verdict, written to `data/<project>/verdicts.json`:

- **real hole**: some input through the public API observes the change
- **equivalent**: no input through the public API can tell the change apart, with the reason
  (for example, a removed element that a later rule also handles, a suffix on a string that is
  only compared with itself)

For a real hole, **expressed by Stryker** is recorded: a Stryker mutant with status `Survived` or
`NoCoverage` on the same line that changes the same token in a way that changes the same
behaviour. Concretely: for `string`, a `StringLiteral` mutant on the same literal; for `number`,
an operator mutant (`ArithmeticOperator`, `EqualityOperator`, `UnaryOperator`, …) on the
expression the number is an operand of, or any mutant that replaces that expression; for
`element`, an `ArrayDeclaration` mutant on the list or a mutant on that element; for `entry`, an
`ObjectLiteral` mutant on the object or a mutant on that entry's value; for `alternative`, a
`Regex` mutant on the same regex. Ambiguous cases are resolved in Stryker's favour.

C1 counts real holes not expressed by Stryker. C2 is real holes ÷ (real holes + equivalent).
A **hole site** is a line with at least one such real hole.

## Deliverables

`docs/benchmarks/0003-value-mutants/`:

- `protocol.md` (this file), committed first
- `projects.md`: pins, licenses, scopes, docs used, reasons, failures
- `scripts/`: the run script and per-project configs
- `patches/`: `<project>-guarantees.patch`, `<project>-links.patch`
- `data/<project>/`: `guarantees.json`, `links.json`, `mutants.json`, the runner's report, a
  Stryker summary (every mutant with status, mutator, location, replacement), specgate's
  `report.json` static and with both reports, `verdicts.json`, timings and versions
- `report.md`: per project and in total, each criterion with counts, failures and limits, issue
  candidates

No third-party source is committed beyond the patches.

## Limits stated in advance

- Ten or eleven projects, one machine, one guarantee author: counts, no statistical inference.
- The equivalence review is done by one reviewer (the author of the feature). Every verdict has
  a written reason so it can be checked.
- Stryker keeps its test runner processes alive between mutants; the runner starts the test
  command once per mutant. C3 measures that difference as it is.

## Deviations

### 1. Harness settings found at the baseline run (2026-11-06, before Stryker ran on any project)

- es-toolkit uses Yarn Plug'n'Play; it was installed with `YARN_NODE_LINKER=node-modules` (same
  lockfile, scripts off). With a `node_modules` tree, its `vitest.config.mts` (whose `exclude`
  replaces vitest's default) picks up test files inside `node_modules`, and
  `tests/check-dist.spec.ts` packs the tarball, which needs a Yarn install state. The test command
  excludes both (`--exclude '**/node_modules/**' --exclude tests/check-dist.spec.ts`), and Stryker
  uses `vitest.stryker.config.mts` with the same exclusions.
- react-hook-form's jest runs with `--watchman=false` (watchman cannot write its state directory
  in the sandbox), as 0001's jest projects.
- h3 and cac declare pnpm 12; pnpm 12.3.4 was installed with `--ignore-scripts` in the scratch
  directory and used for both.

### 2. h3 is not run (2026-11-06, baseline)

h3's tests fail at the pin on this machine (Node 24.3.0): two assertions on `%5E` decoding in
`test/unit/event.test.ts` and `test/unit/route-normalize.test.ts`, and a 5 s timeout in
`test/body-limit.test.ts`. Per **Projects**, it stays in the report with the reason. Its
guarantees were written and frozen before this was known; its tests were not linked.

### 3. One link edited by hand (2026-11-06, linking)

In cron-parser, one entry (`tests/CronExpression.test.ts:366`) was re-keyed after `apply-links.mjs`
ran, by editing the title and `links.json` in the same way; both agree, and every key exists in
`guarantees.json`.

### 4. Runner fix: symlinked directories in sandboxes (2026-11-06, during the runs)

With `--concurrency` above 1, the runner's sandbox copy failed on a symbolic link to a directory
(`.claude/skills/` in valibot): `cpSync` refused to copy it. The runner now recreates symbolic
links with `symlinkSync(readlinkSync(…))`. Site selection and statuses are unchanged. Affected:
valibot (the runner crashed before any mutant ran); its runner step is repeated. defu, neverthrow
and cac had no such link and are not repeated.

### 5. Runner fix: whole-suite runs one at a time (2026-11-06, during the runs)

In es-toolkit, 89 of 113 value mutants have no Stryker mutant whose `coveredBy` narrows the tests
(sites in module-level constants, whose mutants are static), so the runner runs the whole command
for them, as designed. With `--concurrency 15`, fifteen whole-suite vitest runs ran at once; each
vitest already uses every core, and 85 of them passed the timeout. Those `Timeout` statuses came
from the harness, not from the code. The runner now runs whole-command runs one at a time; runs
of selected test files stay parallel. Selection and status rules are unchanged. es-toolkit's run
was stopped and is repeated, and every project not yet run uses the fixed runner. defu,
neverthrow and cac had no `Timeout` and are not repeated.

### 6. react-hook-form: 19 links dropped to keep the suite green (2026-11-06, during the runs)

With the links applied, 16 react-hook-form tests failed, so the run stopped at its first step.
13 of them compare with `toMatchSnapshot()`, whose snapshot name is the test title: renaming the
title makes the stored snapshot unmatched, and jest in CI mode does not write a new one. In 3,
the applier had put the key into a string that was not a title (`getByRole('textbox')`,
`register('test')`), because those link entries named a title that was not a title literal.
The 19 entries behind these failures were dropped (1232 → 1213 links); one more test,
`set value before custom onChange`, failed only through the wrong insertion and keeps its link.
With the rest re-applied, all 1830 tests pass. The patch was refrozen. Other projects' suites
passed at the first step and are unchanged.

### 7. jest projects: watchman off, built-package test excluded (2026-11-06, during the runs)

The baseline check of cron-parser and express-rate-limit was wrong: jest could not start watchman
(it cannot write its state directory in the sandbox), printed the error and exited 0 without
running a test, and that exit code was read as green. Stryker's initial test run then timed out
on cron-parser. Both now run with `--watchman=false` (Stryker: `jest.config.watchman: false`),
as react-hook-form already did, and their baselines were re-checked: cron-parser 798 tests pass;
express-rate-limit passes 249 tests once `test/library/types-test.ts` is excluded, which reads
the built `dist/index.d.ts` (the same kind of check as es-toolkit's `check-dist`, deviation 1).
Both are run from the start; react-hook-form, not yet run, uses the same settings.

### 8. Runner fix: a timed-out run is repeated alone; react-hook-form runs its web project (2026-11-06, during the runs)

- In express-rate-limit, 59 of 61 value mutants were `Timeout` (30 s) with `--concurrency 15`:
  fifteen jest runs on selected test files ran at once, each with its own pool of workers. Run on
  its own, the first two finished in about 9 s each and were `Killed`. The runner now repeats,
  after the parallel phase, every run that timed out, on its own (no other run competing); only a
  second timeout is `Timeout`. express-rate-limit is run again. `Timeout` already counts as
  detected, so the 3 `Timeout`s of es-toolkit (whole-suite runs, already one at a time) and the 1
  of cron-parser cannot change C1 or C2; those two are not repeated, and their runner times are
  as measured.
- Stryker's jest runner does not run jest `projects` (react-hook-form's config has a `web` and a
  `server` project; the jsdom environment was lost and the initial run failed with
  `document is not defined`), and it resolves `rootDir: '.'` against the config file's
  directory. Stryker uses `jest.stryker.config.js`, the `web` project as one flat config with
  `rootDir` at the project root; the test command uses `TEST_ENV=web` as well. Both run the same
  1820 tests; the 10 server-rendering tests (`*.server.test.tsx`) are left out of both.
- express-rate-limit's Stryker config no longer ignores `/.stryker-tmp/`, which held Stryker's
  own sandbox (its first run found no test).

### 9. express-rate-limit: selected test files were swallowed by a jest flag (2026-11-06, during the runs)

express-rate-limit's test command ended with `--testPathIgnorePatterns /node_modules/
/.stryker-tmp/ types-test`. That flag takes every following argument, so the test files the
runner appended were read as more ignore patterns: the runs left out exactly the tests covering
the changed line and ran the others, and 58 of 61 value mutants came back `Survived`. The test
files now go before the flag (`npx jest {files} --watchman=false --testPathIgnorePatterns …`),
and the runner's baseline run now expands `{files}` to nothing as well. express-rate-limit is run
again; its earlier runner result is discarded. No other project's command has such a flag.

### 10. Test selection for module-level sites, measured again after the first results (2026-11-06, after C3 failed)

This is a change made **after** the results were known, so it is reported as a second measurement
next to the pre-registered one, not in its place. In the first measurement, a value mutant in a
module-level constant had no non-static Stryker mutant around it, so the runner ran the whole
suite (89 of es-toolkit's 113). That is a gap in the runner, not in es-toolkit: lookup tables and
default objects are ordinary code. `specgate mutants` now lists, per site, the code that reads it
(`readers`: every function in the program that references the constant) and the test files that
name it (`tests`); the runner selects the tests covering the non-static mutants in those readers,
plus those test files, and still runs the whole suite when a reader is outside Stryker's report or
holds no covered non-static mutant (design note 0004). Site selection and statuses are unchanged.
The runner step (with `specgate mutants`) is repeated on the ten projects with the Stryker reports
of the first measurement (`SKIP_STRYKER=1`); Stryker's times stay as measured. Any value mutant
whose status moves from detected to green between the two measurements is listed in the report:
it would mean the selection left out a test that kills it.

### 11. Runner fix: test files relative to the command's directory; selections checked unchanged (2026-11-06, after deviation 10)

Comparing the first and second measurements found five value mutants that were `Survived` in the
first and `Killed` in the second (react-hotkeys-hook 4, react-hook-form 1). Run alone against the
whole suite, all five survive. The cause: where the test command runs in a subdirectory (valibot
in `library`, react-hotkeys-hook in `packages/react-hotkeys-hook`), the runner passed the selected
test files relative to the repository root; vitest found none, exited 1, and the runner read
that as `Killed`. This affects **both** earlier measurements of those two projects (valibot's 51
and react-hotkeys-hook's 16 `Killed`), so their earlier runner results are not valid. In
react-hook-form, the selected tests pass without any change (1419 tests), and the one kill did not
reproduce when the mutant was run alone against the whole suite: most likely a test that failed
under the load of fifteen parallel jest runs. That is a limit of the runner (and of Stryker), not
fixed here; the third measurement shows whether it recurs. The runner now takes `--cwd` and passes test files relative to it, and runs
each distinct selection once without any change: a selection that fails falls back to the whole
suite. The runner step is repeated on all ten projects (third measurement); the report's numbers
come from it, with the first measurement kept beside them (`data/first-run/`).

### 12. Shorter runner runs: callers of readers, Stryker-style timeouts, bail (2026-11-06, after the final measurement of deviation 11)

Also post hoc, and only about time. After deviation 11, the remaining whole-suite runs were
sites whose readers the Stryker report cannot place (react-hook-form: `createFormControl.ts` is
not in `mutate`, 36 runs; es-toolkit: Stryker marks `deburr` static, 11 runs), and a `Timeout`
waited a fixed 30 s twice (cron-parser). Three changes: `specgate mutants` lists the `callers` of
each named reader (by name references, three levels) and the test files naming them, and the
runner reaches such readers through their callers; the timeout of a run is its selection's
unchanged run time × 1.5 + 5 s, as Stryker's; the test commands stop at the first failure
(`vitest --bail=1`, `jest --bail`), as Stryker's runs do. Stryker's configs and reports are
unchanged. The runner step is repeated on the ten projects (fourth measurement) and every
status is compared with the third measurement's; a value mutant moving from detected to green
would mean the selection left out a test that kills it, and is listed in the report.

Addendum (same day): the first pass of the fourth measurement used the Stryker-style limit for
parallel runs too, and express-rate-limit had 17 timeouts under fifteen parallel runs, each
repeated alone (58 s → 128 s). Parallel runs now get net time × 3 + 10 s; runs alone keep
× 1.5 + 5 s. A stack overflow in react-hook-form's caller tree was fixed. The runner step was
repeated on all ten projects with these settings; that run is the fourth measurement.
