# Benchmark 0003 — Value mutants: report

Protocol: `protocol.md` (committed before any run; deviations 1–12 at its end). Projects, pins,
scopes and docs: `projects.md`. Raw data: `data/`. Totals: `data/metrics.json`
(`scripts/metrics.mjs`). specgate and the runner: this branch. Stryker 10.1.1. Node 24.3.0,
macOS, Apple M3 Max, 16 logical cores. Counts below do not generalise beyond these projects.

## Four runner measurements

The criteria were fixed before the first run. The runner changed three times after results were
known, and the report says which numbers come from which:

| Measurement        | Runner                                                                                             | Data                                  | Valid                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| first              | as pre-registered, plus the harness fixes of deviations 1–9                                        | `data/first-run/`                     | not for valibot and react-hotkeys-hook (deviation 11); its timings are |
| second             | + test selection for module-level sites through their readers (deviation 10)                       | `data/second-run/`                    | not for valibot and react-hotkeys-hook (deviation 11)                  |
| third              | + test files relative to `--cwd`; each selection checked without any change (deviation 11)         | `data/third-run/`                     | yes                                                                    |
| **fourth (final)** | + readers' callers; Stryker-style timeouts; test commands stop at the first failure (deviation 12) | `data/<project>/`, `data/fourth-run/` | yes                                                                    |

Stryker ran once per project (in the first measurement); every runner measurement uses those
reports. Value mutants, verdicts and the criteria below come from the final measurement. Between
the third and the fourth, no value mutant moved from detected to green except the flaky kills
listed below, so the changes of deviation 12 only made runs shorter.

## Verdict

| #   | Criterion                                                                                                    | Final                                                        | First (pre-registered runner) | Holds (final) |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------- | ------------- |
| C1  | Real holes no `Survived` / `NoCoverage` Stryker mutant expresses, in more than half of the projects that ran | 6 of 10                                                      | 6 of 10                       | yes           |
| C2  | Green value mutants that are real holes, after the equivalence review, at least 70%                          | 98 of 111 (88%)                                              | 83 of 96 (86%)                | yes           |
| C3  | Runner wall-clock with `coveredBy` selection, at most 2× Stryker's, summed                                   | 613 s vs 1262 s: **0.49×**                                   | 3276 s vs 1262 s: **2.60×**   | yes           |
| C4  | Static `decision-*` findings on 0001's six projects, no more than 0.5.0                                      | 15 vs 15, equal in every project; 8 after merging main (#73) | same                          | yes           |

**All four criteria hold in the final measurement. C3 failed with the pre-registered runner
(2.60×)** and holds only after selection changes made once that result was known (deviations 10
and 12), so read C3 as a post-hoc result. The pre-registered runner fell back to the whole suite
for every value mutant in a module-level constant (89 of es-toolkit's 113; 65 of hono's 139 in the
regression check), because Stryker does not track static code per test. That was a gap in the
runner, not in those projects: lookup tables and default objects are ordinary code.

The first measurement's C1 and C2 also rest on runner results that deviation 11 invalidates for
valibot and react-hotkeys-hook; they are shown for comparison only.

## Per project (final measurement)

`green` = `Survived` + `NoCoverage`. `not expr.` = real holes no Stryker survivor expresses (the
protocol's rule, ambiguous cases in Stryker's favour). Times are wall-clock seconds; the runner used
Stryker's concurrency (15).

| Project            | Value mutants | Killed / Timeout | Survived | NoCov |   Real | Equiv. | Not expr. | Stryker s | Runner s, first | Runner s, third | Runner s |    Ratio |
| ------------------ | ------------: | ---------------: | -------: | ----: | -----: | -----: | --------: | --------: | --------------: | --------------: | -------: | -------: |
| es-toolkit         |           113 |          108 / 0 |        5 |     0 |      1 |      4 |         0 |        62 |            2392 |             151 |       43 |     0.69 |
| defu               |             3 |            0 / 0 |        2 |     1 |      3 |      0 |         0 |         6 |               2 |               2 |        2 |     0.30 |
| valibot            |            51 |           38 / 0 |       13 |     0 |     13 |      0 |         0 |        89 |             100 |              50 |       42 |     0.48 |
| cron-parser        |            20 |            9 / 1 |       10 |     0 |      8 |      2 |         3 |        98 |              32 |             120 |       25 |     0.26 |
| neverthrow         |             0 |                — |        — |     — |      — |      — |         — |         8 |               2 |               2 |        1 |     0.12 |
| jotai              |            36 |           18 / 0 |       18 |     0 |     14 |      4 |         4 |       121 |              68 |              31 |       19 |     0.15 |
| react-hook-form    |            53 |           37 / 0 |       16 |     0 |     15 |      1 |        15 |       599 |             476 |             464 |      342 |     0.57 |
| react-hotkeys-hook |            20 |           13 / 0 |        7 |     0 |      7 |      0 |         4 |       203 |             119 |              59 |       61 |     0.30 |
| express-rate-limit |            61 |           34 / 0 |       26 |     1 |     25 |      2 |        10 |        67 |              77 |              58 |       72 |     1.08 |
| cac                |            22 |           10 / 0 |        6 |     6 |     12 |      0 |         1 |        10 |               8 |               7 |        7 |     0.64 |
| **total**          |       **379** |      **267 / 1** |  **103** | **8** | **98** | **13** |    **37** |  **1262** |        **3276** |         **943** |  **613** | **0.49** |

h3 was not run: its tests fail at the pin on this machine (deviation 2).

Value mutants by kind: 166 string, 107 number, 58 element, 48 entry, 0 alternative (no scope had a
regex group of plain words). `specgate mutants` took 0.7–4.8 s per project. Whole-suite runs left
in the final measurement: 11, all in react-hook-form, whose `EVENTS` are read through code that
neither Stryker covers (`createFormControl.ts` is outside `mutate`) nor a name reference reaches
from covered code (its methods are called on the returned object). react-hook-form also had 15
runs that timed out under the shared load and passed alone.

Every green value mutant was reviewed (`data/<project>/verdicts.json`, one written reason each).
`check` with both reports gave one `mutant-survived` per green value mutant on a unit with linked
tests (108 of 111; the other 3 are `NoCoverage` in cac units no test is linked to, which 0003 does
not report), each attributed to a unit and worded in contract terms.

### Groups worth reading separately

Three groups are real by the protocol's rule (some input observes them) but weaker:

| Group                                                                                  | Real | Not expr. | Where              |
| -------------------------------------------------------------------------------------- | ---: | --------: | ------------------ |
| `process.env.NODE_ENV !== 'production'` strings: observable only in a production build |    9 |         1 | jotai              |
| log text: `debug(…)` lines, the debug namespace, `logger.error` text                   |   20 |         7 | express-rate-limit |
| loop limits: observable only for an input needing exactly that many iterations         |    2 |         2 | cron-parser        |

Without them: C2 is 67 of 80 (84%); C1 still holds in the same 6 projects (each has a real hole
outside these groups that Stryker does not express).

### The real holes Stryker does not express (outside the groups above)

| Project            | Site                        | Change                                                                          | Effect                                                                                                                                                                          |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| express-rate-limit | `rate-limit.ts:207`         | default `windowMs` `60 * 1000` → `61 * 1000`, `60 * 1001`                       | the documented default of one minute (2 mutants)                                                                                                                                |
| express-rate-limit | `rate-limit.ts:264`         | default `ipv6Subnet` 56 → 57                                                    | IPv6 clients grouped by /57 instead of the documented /56                                                                                                                       |
| react-hook-form    | `useForm.ts:21–28`          | an entry removed from `RESET_OPTIONS`                                           | dropping `reValidateMode`, `shouldFocusError`, `criteriaMode`, `delayError`, `shouldUnregister`, `shouldUseNativeValidation` or `context` on a rerender no longer resets it (7) |
| react-hook-form    | `constants.ts:3–7`          | `EVENTS.FOCUS_OUT` / `SUBMIT` / `TRIGGER` / `VALID` changed or removed          | `focusout` no longer counts as blur; the form-level `validate` sees a wrong `eventType` (8)                                                                                     |
| react-hotkeys-hook | `HotkeysProvider.tsx:18–19` | `toggleScope` / `enableScope` / `disableScope` removed from the default context | without a provider, calling them throws (3)                                                                                                                                     |
| react-hotkeys-hook | `useHotkeys.ts:150`         | default `sequenceTimeoutMs` 1000 → 1001                                         | the sequence timeout default                                                                                                                                                    |
| jotai              | `splitAtom.ts:167`, `:206`  | `arr.slice(0, index)` → `slice(1, …)`; `index1 + 1` → `+ 2`                     | remove drops the first element; a backward move drops an element                                                                                                                |
| jotai              | `constants.ts:6`            | `'RESET'` → `'RESET_x'`                                                         | `RESET.description` changes                                                                                                                                                     |
| cron-parser        | `CronExpression.ts:530`     | `getMilliseconds() > 0` → `> 1`                                                 | from a start at exactly 1 ms, `next()` can return the start second                                                                                                              |
| cac                | `cac.ts:347`                | `type[0]` → `type[1]`                                                           | an array option `type: [Number]` stops converting its values                                                                                                                    |

Of the 37 not expressed, 8 (react-hook-form's `EVENTS`) are in `src/constants.ts`, which is not in
Stryker's `mutate` but is a module-level constant the scoped units read; the other 29 are in
scoped files. Counting only scoped files, C1 still holds in the same 6 projects. Guarantees written
from the docs name the changed value in 26 of the 98 real holes (an approximate text match,
`scripts/metrics.mjs`), among them `windowMs` 60000, `ipv6Subnet` 56 and valibot's issue labels.

### Equivalent value mutants (13)

es-toolkit 4 (three range limits of `deburr` where NFD does not decompose the boundary character;
the `'&#39;'` entry of `unescape`, whose fallback returns the same character), jotai 4 (refresh
counters whose value is never read), cron-parser 2 (a cache key; a DST walk over hour 24),
express-rate-limit 2 (initial values always overwritten), react-hook-form 1 (a truthy return value).

### Flaky kills

Across the measurements, four value mutants that cannot fail a test were `Killed` in some run and
green in others: es-toolkit `value-65` (reviewed equivalent), react-hook-form `value-50` (survives
alone against the whole suite), express-rate-limit `value-33` and `value-40` (the text of a
`debug()` line). Most likely tests that failed under fifteen parallel runs. In the final
measurement only express-rate-limit `value-40` is affected; it is not counted. A flaky kill hides a
hole, so it lowers C1 and C2, never raises them. The runner does not re-run kills.

## Regression check on 0001's six projects

**C4.** `specgate check` from this branch with 0001's configs and committed patches, against
0001's recorded 0.5.0 results (`data/c4/`, `scripts/c4.sh`). The value-mutant runs used this
branch before main's #73 (false-positive fixes from 0001) was merged; C4 was measured on both,
the latter in `data/c4-after-main-merge/`:

| Project       | 0.5.0 `decision-*` | this branch | after merging main | Units (0.5.0 → branch)                              |
| ------------- | -----------------: | ----------: | -----------------: | --------------------------------------------------- |
| scule         |                  4 |           4 |                  0 | 11 → 11                                             |
| ufo           |                  4 |           4 |                  4 | 9 → 9                                               |
| zustand       |                  0 |           0 |                  0 | 4 → 4                                               |
| mantine-hooks |                  0 |           0 |                  0 | 6 → 6                                               |
| ahooks        |                  0 |           0 |                  0 | 0 → 3 (#63, a declaration exported only as default) |
| hono          |                  7 |           7 |                  4 | 5 → 5                                               |

**Value mutants, counts only** (no equivalence review; the third measurement's runner in
`data/regression/`, the first's in `data/regression-first/`):

| Project       | Value mutants | Killed | Survived | NoCov | Stryker s | Runner s, first | Runner s |
| ------------- | ------------: | -----: | -------: | ----: | --------: | --------------: | -------: |
| scule         |            35 |     17 |       18 |     0 |         6 |              27 |        9 |
| ufo           |            25 |     20 |        5 |     0 |        13 |               8 |        7 |
| zustand       |             2 |      1 |        1 |     0 |        61 |               6 |        5 |
| mantine-hooks |            44 |     27 |        7 |    10 |        17 |             257 |      144 |
| ahooks        |             3 |      1 |        2 |     0 |        47 |              20 |       17 |
| hono          |           139 |    130 |        8 |     1 |       459 |            1473 |       30 |

mantine stays slower than Stryker: its test command names the package directory
(`jest packages/@mantine/hooks`), so the selected files cannot narrow it. ahooks' runner used
`vitest run --project ahooks` from the root: two test files of another package in its workspace
fail at the pin.

## Failures and limits

- **h3** was not run (deviation 2). Its guarantees are frozen in `patches/`.
- **neverthrow** has no value site in its scope (the issue's "check on noise"): 0 value mutants.
- **C3 is post hoc.** The selection that makes it hold was written after the pre-registered runner
  failed it. A benchmark on other projects would confirm it.
- Twelve deviations were needed (protocol). Six are runner fixes: symbolic links in sandboxes;
  whole-suite runs one at a time; a timed-out run repeated alone; `{files}` in the baseline run;
  test files relative to `--cwd`, with each selection checked unchanged; a stack overflow and the
  timeouts of shared runs. Two are runner features (deviations 10 and 12). The others are project
  settings: watchman, jest `projects`, a built-package test, a variadic jest flag, links that broke
  snapshot names.
- **Selection is by name references.** A reader's callers are traced through identifiers that
  resolve to it; a call through a method, a callback or a re-export under another name is not
  traced, and then the reader has no `callers` and the runner falls back to the whole suite. A
  test that reaches code only through such a path, while the code also has traced callers, would
  be left out; no such case appeared (no value mutant moved from detected to green between the
  whole-suite and the selected runs, apart from the flaky kills).
- One reviewer judged equivalence, the author of the feature. Every verdict has a reason.
- Stryker's own wall-clock varied between runs (es-toolkit 95 s in a stopped run, 62 s in the
  counted one); some short manual test runs overlapped with Stryker or runner runs.
- The runner starts the test command once per mutant; Stryker keeps runners alive. C3 measures that
  as it is.

## Issue candidates

1. **Skip log and environment strings.** Skip `debug(…)`, `logger.*(…)` arguments and the debug
   namespace (express-rate-limit, 20) and `process.env.NODE_ENV` comparison strings (jotai, 9)
   like `console.*`, and error-message constants (`*_ERROR_MESSAGE`, cron-parser) like thrown
   messages.
2. **Runner: confirm kills.** A kill caused by a flaky test hides a hole (4 seen here). Re-running
   each `Killed` once on its own would show them, at the cost of one more run per kill.
3. **Runner: test commands with variadic flags.** Appended test files are swallowed by flags such
   as jest's `--testPathIgnorePatterns` (deviation 9). The selection check of deviation 11 catches
   the "no test found" case, but not a run of the wrong tests. Document `{files}`.
4. **Callers through methods.** react-hook-form's last 11 whole-suite runs are code reached through
   methods of an object a factory returns. Tracing property references on the factory's return
   type would cover them, at the cost of a less certain superset.
5. **Stryker scope vs. value sites.** Value sites follow the constants a unit reads into other
   files; Stryker's `mutate` does not. Report value mutants outside the Stryker report's files as
   such in the Step Summary.
