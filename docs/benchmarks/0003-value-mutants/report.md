# Benchmark 0003 — Value mutants: report

Protocol: `protocol.md` (committed before any run; deviations 1–11 at its end). Projects, pins,
scopes and docs: `projects.md`. Raw data: `data/`. Totals: `data/metrics.json`
(`scripts/metrics.mjs`). specgate and the runner: this branch. Stryker 10.1.1. Node 24.3.0,
macOS, Apple M3 Max, 16 logical cores. Counts below do not generalise beyond these projects.

## Three measurements

The criteria were fixed before the first run. The runner changed twice after results were known,
and the report says which numbers come from which:

| Measurement | Runner                                                                                            | Data               | Valid                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| first       | as pre-registered, plus the harness fixes of deviations 1–9                                       | `data/first-run/`  | no for valibot and react-hotkeys-hook (deviation 11); timings are |
| second      | + test selection for module-level sites through their readers (deviation 10)                      | `data/second-run/` | no for valibot and react-hotkeys-hook (deviation 11)              |
| **final**   | + test files passed relative to `--cwd`; each selection checked without any change (deviation 11) | `data/<project>/`  | yes                                                               |

Stryker ran once per project (in the first measurement); every runner measurement uses those
reports. Value mutants, verdicts and the criteria below are from the final measurement.

## Verdict

| #   | Criterion                                                                                                    | Final                                                        | First (pre-registered runner) | Holds (final) |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------- | ------------- |
| C1  | Real holes no `Survived` / `NoCoverage` Stryker mutant expresses, in more than half of the projects that ran | 6 of 10                                                      | 6 of 10                       | yes           |
| C2  | Green value mutants that are real holes, after the equivalence review, at least 70%                          | 97 of 109 (89%)                                              | 83 of 96 (86%)                | yes           |
| C3  | Runner wall-clock with `coveredBy` selection, at most 2× Stryker's, summed                                   | 943 s vs 1262 s: **0.75×**                                   | 3276 s vs 1262 s: **2.60×**   | yes           |
| C4  | Static `decision-*` findings on 0001's six projects, no more than 0.5.0                                      | 15 vs 15, equal in every project; 8 after merging main (#73) | same                          | yes           |

**All four criteria hold in the final measurement. C3 failed with the pre-registered runner
(2.60×)** and holds only after a selection change made once that result was known (deviation 10),
so read C3 as a post-hoc result. The pre-registered runner fell back to the whole suite for every
value mutant in a module-level constant (89 of es-toolkit's 113; 65 of hono's 139 in the
regression check), because Stryker does not track static code per test. That was a gap in the
runner, not in those projects: lookup tables and default objects are ordinary code.

The first measurement's C1 and C2 also rest on runner results that deviation 11 invalidates for
valibot and react-hotkeys-hook; they are shown for comparison only.

## Per project (final measurement)

`green` = `Survived` + `NoCoverage`. `not expr.` = real holes no Stryker survivor expresses (the
protocol's rule, ambiguous cases in Stryker's favour). Times are wall-clock seconds; the runner used
Stryker's concurrency (15). "Runner s, first" is the pre-registered runner.

| Project            | Value mutants | Killed / Timeout | Survived | NoCov |   Real | Equiv. | Not expr. | Stryker s | Runner s, first | Runner s |    Ratio |
| ------------------ | ------------: | ---------------: | -------: | ----: | -----: | -----: | --------: | --------: | --------------: | -------: | -------: |
| es-toolkit         |           113 |          109 / 0 |        4 |     0 |      1 |      3 |         0 |        62 |            2392 |      151 |     2.45 |
| defu               |             3 |            0 / 0 |        2 |     1 |      3 |      0 |         0 |         6 |               2 |        2 |     0.30 |
| valibot            |            51 |           38 / 0 |       13 |     0 |     13 |      0 |         0 |        89 |             100 |       50 |     0.56 |
| cron-parser        |            20 |            9 / 1 |       10 |     0 |      8 |      2 |         3 |        98 |              32 |      120 |     1.23 |
| neverthrow         |             0 |                — |        — |     — |      — |      — |         — |         8 |               2 |        2 |     0.19 |
| jotai              |            36 |           18 / 0 |       18 |     0 |     14 |      4 |         4 |       121 |              68 |       31 |     0.26 |
| react-hook-form    |            53 |           35 / 3 |       15 |     0 |     14 |      1 |        14 |       599 |             476 |      464 |     0.77 |
| react-hotkeys-hook |            20 |           13 / 0 |        7 |     0 |      7 |      0 |         4 |       203 |             119 |       59 |     0.29 |
| express-rate-limit |            61 |           34 / 0 |       26 |     1 |     25 |      2 |        10 |        67 |              77 |       58 |     0.87 |
| cac                |            22 |           10 / 0 |        6 |     6 |     12 |      0 |         1 |        10 |               8 |        7 |     0.64 |
| **total**          |       **379** |      **266 / 4** |  **101** | **8** | **97** | **12** |    **36** |  **1262** |        **3276** |  **943** | **0.75** |

h3 was not run: its tests fail at the pin on this machine (deviation 2).

Value mutants by kind: 166 string, 107 number, 58 element, 48 entry, 0 alternative (no scope had a
regex group of plain words). `specgate mutants` took 0.7–4.8 s per project. es-toolkit still runs
11 value mutants against its whole suite: Stryker marks the body of `deburr` itself static, so
nothing tells which tests run it. react-hook-form's `EVENTS` are read by `createFormControl.ts`,
outside Stryker's `mutate`, so its 36 module-level value mutants also run the whole (web) suite.

Every green value mutant was reviewed (`data/<project>/verdicts.json`, one written reason each).
`check` with both reports gave one `mutant-survived` per green value mutant on a unit with linked
tests (106 of 109; the other 3 are `NoCoverage` in cac units no test is linked to, which 0003 does
not report), each attributed to a unit and worded in contract terms.

### Groups worth reading separately

Three groups are real by the protocol's rule (some input observes them) but weaker:

| Group                                                                                  | Real | Not expr. | Where              |
| -------------------------------------------------------------------------------------- | ---: | --------: | ------------------ |
| `process.env.NODE_ENV !== 'production'` strings: observable only in a production build |    9 |         1 | jotai              |
| log text: `debug(…)` lines, the debug namespace, `logger.error` text                   |   20 |         7 | express-rate-limit |
| loop limits: observable only for an input needing exactly that many iterations         |    2 |         2 | cron-parser        |

Without them: C2 is 66 of 78 (85%); C1 still holds in the same 6 projects (each has a real hole
outside these groups that Stryker does not express).

### The real holes Stryker does not express (outside the groups above)

| Project            | Site                        | Change                                                                          | Effect                                                                                                                                             |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| express-rate-limit | `rate-limit.ts:207`         | default `windowMs` `60 * 1000` → `61 * 1000`, `60 * 1001`                       | the documented default of one minute (2 mutants)                                                                                                   |
| express-rate-limit | `rate-limit.ts:264`         | default `ipv6Subnet` 56 → 57                                                    | IPv6 clients grouped by /57 instead of the documented /56                                                                                          |
| react-hook-form    | `useForm.ts:21–28`          | an entry removed from `RESET_OPTIONS`                                           | dropping `reValidateMode`, `shouldFocusError`, `criteriaMode`, `delayError`, `shouldUnregister` or `context` on a rerender no longer resets it (6) |
| react-hook-form    | `constants.ts:3–7`          | `EVENTS.FOCUS_OUT` / `SUBMIT` / `TRIGGER` / `VALID` changed or removed          | `focusout` no longer counts as blur; the form-level `validate` sees a wrong `eventType` (8)                                                        |
| react-hotkeys-hook | `HotkeysProvider.tsx:18–19` | `toggleScope` / `enableScope` / `disableScope` removed from the default context | without a provider, calling them throws (3)                                                                                                        |
| react-hotkeys-hook | `useHotkeys.ts:150`         | default `sequenceTimeoutMs` 1000 → 1001                                         | the sequence timeout default                                                                                                                       |
| jotai              | `splitAtom.ts:167`, `:206`  | `arr.slice(0, index)` → `slice(1, …)`; `index1 + 1` → `+ 2`                     | remove drops the first element; a backward move drops an element                                                                                   |
| jotai              | `constants.ts:6`            | `'RESET'` → `'RESET_x'`                                                         | `RESET.description` changes                                                                                                                        |
| cron-parser        | `CronExpression.ts:530`     | `getMilliseconds() > 0` → `> 1`                                                 | from a start at exactly 1 ms, `next()` can return the start second                                                                                 |
| cac                | `cac.ts:347`                | `type[0]` → `type[1]`                                                           | an array option `type: [Number]` stops converting its values                                                                                       |

Of the 36 not expressed, 8 (react-hook-form's `EVENTS`) are in `src/constants.ts`, which is not in
Stryker's `mutate` but is a module-level constant the scoped units read; the other 28 are in
scoped files. Counting only scoped files, C1 still holds in the same 6 projects. Guarantees written
from the docs name the changed value in 26 of the 97 real holes (an approximate text match,
`scripts/metrics.mjs`), among them `windowMs` 60000, `ipv6Subnet` 56 and valibot's issue labels.

### Equivalent value mutants (12)

es-toolkit 3 (two range limits of `deburr` where NFD does not decompose the boundary character;
the `'&#39;'` entry of `unescape`, whose fallback returns the same character), jotai 4 (refresh
counters whose value is never read), cron-parser 2 (a cache key; a DST walk over hour 24),
express-rate-limit 2 (initial values always overwritten), react-hook-form 1 (a truthy return value).

### Flaky kills

Three value mutants green in the first measurement were `Killed` in the final one although the
change cannot fail a test: es-toolkit `value-65` (reviewed equivalent), react-hook-form `value-50`
(survives when run alone against the whole suite), express-rate-limit `value-33` (the text of a
`debug()` line). Most likely these were tests that failed under fifteen parallel runs. They are not
counted. A flaky kill hides a hole, so it lowers C1 and C2, never raises them. In the regression
check one mantine value mutant moved the same way. The runner does not re-run kills.

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

**Value mutants, counts only** (no equivalence review; final runner in `data/regression/`, first
in `data/regression-first/`):

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
- Eleven deviations were needed (protocol). Five are runner fixes: symbolic links in sandboxes;
  whole-suite runs one at a time; a timed-out run repeated alone; `{files}` in the baseline run;
  test files relative to `--cwd`, with each selection checked unchanged. One is a runner feature
  (deviation 10). The others are project settings: watchman, jest `projects`, a built-package
  test, a variadic jest flag, links that broke snapshot names.
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
2. **Runner: confirm kills.** A kill caused by a flaky test hides a hole (3 seen here). Re-running
   each `Killed` once on its own would show them, at the cost of one more run per kill.
3. **Runner: test commands with variadic flags.** Appended test files are swallowed by flags such
   as jest's `--testPathIgnorePatterns` (deviation 9). The selection check of deviation 11 catches
   the "no test found" case, but not a run of the wrong tests. Document `{files}`.
4. **Static readers.** When Stryker marks a reader itself static (es-toolkit's `deburr`), or the
   reader is outside `mutate` (react-hook-form's `createFormControl`), the runner still falls back
   to the whole suite. specgate could pass the test files linked to the units that reach the site
   as a further candidate set. That set is not a superset of the observing tests, so it would need
   its own check.
5. **Stryker scope vs. value sites.** Value sites follow the constants a unit reads into other
   files; Stryker's `mutate` does not. Report value mutants outside the Stryker report's files as
   such in the Step Summary.
