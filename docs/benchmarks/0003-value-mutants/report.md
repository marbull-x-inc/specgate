# Benchmark 0003 — Value mutants: report

Protocol: `protocol.md` (committed before any run, deviations 1–9 at its end). Projects, pins,
scopes and docs: `projects.md`. Raw data: `data/`. Totals: `data/metrics.json`
(`scripts/metrics.mjs`). specgate and the runner: this branch, at the commits named in the
deviations (site selection unchanged throughout). Stryker 10.1.1. Node 24.3.0, macOS, Apple M3 Max,
16 logical cores. Counts below do not generalise beyond these projects.

## Verdict

| #   | Criterion                                                                                                    | Result                                                        | Holds  |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------ |
| C1  | Real holes no `Survived` / `NoCoverage` Stryker mutant expresses, in more than half of the projects that ran | 6 of 10 projects (needs more than 5)                          | yes    |
| C2  | Green value mutants that are real holes, after the equivalence review, at least 70%                          | 83 of 96 (86%)                                                | yes    |
| C3  | Runner wall-clock with `coveredBy` selection, at most 2× Stryker's, summed                                   | 3276 s against 1262 s: **2.60×**                              | **no** |
| C4  | Static `decision-*` findings on 0001's six projects, no more than 0.5.0                                      | 15 and 15, equal in every project; 8 after merging main (#73) | yes    |

**C3 fails by 0.60× (about 752 s over the 2× budget of 2524 s).** One project accounts for it:
es-toolkit's runner took 2392 s against Stryker's 62 s, because 89 of its 113 value mutants sit in
module-level constants (the `deburr` table), where no Stryker mutant's `coveredBy` narrows the
tests, so each ran the whole 15 s suite, one at a time (deviation 5). Without es-toolkit the ratio
is 885 s / 1200 s = 0.74×. Per the protocol, the feature stays on its branch (or ships behind an
`experimental` flag); that is decided with these numbers, not here.

## Per project

`green` = `Survived` + `NoCoverage`. `not expr.` = real holes no Stryker survivor expresses (the
protocol's rule, ambiguous cases in Stryker's favour). Times are wall-clock seconds; the runner
used Stryker's concurrency (15).

| Project            |                                                    Value mutants | Killed / Timeout | Survived | NoCov |   Real | Equiv. | Not expr. | Stryker s | Runner s |    Ratio |
| ------------------ | ---------------------------------------------------------------: | ---------------: | -------: | ----: | -----: | -----: | --------: | --------: | -------: | -------: |
| es-toolkit         |                                                              113 |          105 / 3 |        5 |     0 |      1 |      4 |         0 |        62 |     2392 |     38.6 |
| defu               |                                                                3 |            0 / 0 |        2 |     1 |      3 |      0 |         0 |         6 |        2 |     0.36 |
| valibot            |                                                               51 |           51 / 0 |        0 |     0 |      0 |      0 |         0 |        89 |      100 |     1.13 |
| cron-parser        |                                                               20 |            9 / 1 |       10 |     0 |      8 |      2 |         3 |        98 |       32 |     0.33 |
| neverthrow         |                                                                0 |                — |        — |     — |      — |      — |         — |         8 |        2 |     0.19 |
| jotai              |                                                               36 |           18 / 0 |       18 |     0 |     14 |      4 |         4 |       121 |       68 |     0.56 |
| react-hook-form    |                                                               53 |           34 / 3 |       16 |     0 |     15 |      1 |        15 |       599 |      476 |     0.79 |
| react-hotkeys-hook |                                                               20 |           16 / 0 |        4 |     0 |      4 |      0 |         3 |       203 |      119 |     0.59 |
| express-rate-limit |                                                               61 |           33 / 0 |       27 |     1 |     26 |      2 |        10 |        67 |       77 |     1.16 |
| cac                |                                                               22 |           10 / 0 |        6 |     6 |     12 |      0 |         1 |        10 |        8 |     0.78 |
| **total**          |                                                          **379** |      **276 / 7** |   **88** | **8** | **83** | **13** |    **36** |  **1262** | **3276** | **2.60** |
| h3                 | not run: its tests fail at the pin on this machine (deviation 2) |                  |          |       |        |        |           |           |          |          |

Value mutants by kind: 166 string, 107 number, 58 element, 48 entry, 0 alternative (no scope had a
regex group of plain words). `specgate mutants` took 0.7–4.8 s per project.

Every green value mutant was reviewed (`data/<project>/verdicts.json`, one written reason each).
`check` with both reports gave one `mutant-survived` per green value mutant on a unit with linked
tests (93 of 96; the other 3 are `NoCoverage` in cac units no test is linked to, which 0003 does not
report), each attributed to a unit and worded in contract terms.

### Groups worth reading separately

Three groups are real by the protocol's rule (some input observes them) but weaker:

| Group                                                                                  | Real | Not expr. | Where              |
| -------------------------------------------------------------------------------------- | ---: | --------: | ------------------ |
| `process.env.NODE_ENV !== 'production'` strings: observable only in a production build |    9 |         1 | jotai              |
| log text: `debug(…)` lines, the debug namespace, `logger.error` text                   |   21 |         8 | express-rate-limit |
| loop limits: observable only for an input needing exactly that many iterations         |    2 |         2 | cron-parser        |

Without them: C2 is 51 of 64 (80%); C1 still holds in the same 6 projects (each has a real hole
outside these groups not expressed by Stryker).

### The real holes Stryker does not express (outside the groups above)

| Project            | Site                        | Change                                                                          | Effect                                                                                                                                                                          |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| express-rate-limit | `rate-limit.ts:207`         | default `windowMs` `60 * 1000` → `61 * 1000`, `60 * 1001`                       | the documented default of one minute (2 mutants)                                                                                                                                |
| express-rate-limit | `rate-limit.ts:264`         | default `ipv6Subnet` 56 → 57                                                    | IPv6 clients grouped by /57 instead of the documented /56                                                                                                                       |
| react-hook-form    | `useForm.ts:21–28`          | an entry removed from `RESET_OPTIONS`                                           | dropping `reValidateMode`, `shouldFocusError`, `criteriaMode`, `delayError`, `shouldUnregister`, `shouldUseNativeValidation` or `context` on a rerender no longer resets it (7) |
| react-hook-form    | `constants.ts:3–7`          | `EVENTS.FOCUS_OUT` / `SUBMIT` / `TRIGGER` / `VALID` changed or removed          | `focusout` no longer counts as blur; the form-level `validate` sees a wrong `eventType` (8)                                                                                     |
| react-hotkeys-hook | `HotkeysProvider.tsx:18–19` | `toggleScope` / `enableScope` / `disableScope` removed from the default context | without a provider, calling them throws (3)                                                                                                                                     |
| jotai              | `splitAtom.ts:167`, `:206`  | `arr.slice(0, index)` → `slice(1, …)`; `index1 + 1` → `+ 2`                     | remove drops the first element; a backward move drops an element                                                                                                                |
| jotai              | `constants.ts:6`            | `'RESET'` → `'RESET_x'`                                                         | `RESET.description` changes                                                                                                                                                     |
| cron-parser        | `CronExpression.ts:530`     | `getMilliseconds() > 0` → `> 1`                                                 | from a start at exactly 1 ms, `next()` can return the start second                                                                                                              |
| cac                | `cac.ts:347`                | `type[0]` → `type[1]`                                                           | an array option `type: [Number]` stops converting its values                                                                                                                    |

Of the 36 not expressed, 8 (react-hook-form's `EVENTS`) are in `src/constants.ts`, which is not in
Stryker's `mutate` (the scope's files) but is a module-level constant the scoped units read; the
other 28 are in scoped files. Counting only scoped files, C1 still holds in the same 6 projects.
Guarantees written from the docs name the changed value in 12 of the 83 real holes (an
approximate text match, `scripts/metrics.mjs`), among them `windowMs` 60000 and `ipv6Subnet` 56.

### Equivalent value mutants (13)

es-toolkit 4 (range limits of `deburr` where NFD does not decompose the boundary character; the
`'&#39;'` entry of `unescape`, whose fallback returns the same character), jotai 4 (refresh
counters whose value is never read), cron-parser 2 (a cache key; a DST walk over hour 24),
express-rate-limit 2 (initial values always overwritten), react-hook-form 1 (a truthy return value).

## Regression check on 0001's six projects

**C4.** `specgate check` from this branch with 0001's configs and committed patches, against
0001's recorded 0.5.0 results (`data/c4/`, `scripts/c4.sh`). The value-mutant runs above used this
branch before main's #73 (false-positive fixes from 0001) was merged; C4 was measured on both, the
latter in `data/c4-after-main-merge/`. Value mutants were not re-run after the merge:

| Project       | 0.5.0 `decision-*` | this branch | after merging main | Units (0.5.0 → branch)                              |
| ------------- | -----------------: | ----------: | -----------------: | --------------------------------------------------- |
| scule         |                  4 |           4 |                  0 | 11 → 11                                             |
| ufo           |                  4 |           4 |                  4 | 9 → 9                                               |
| zustand       |                  0 |           0 |                  0 | 4 → 4                                               |
| mantine-hooks |                  0 |           0 |                  0 | 6 → 6                                               |
| ahooks        |                  0 |           0 |                  0 | 0 → 3 (#63, a declaration exported only as default) |
| hono          |                  7 |           7 |                  4 | 5 → 5                                               |

**Value mutants, counts only** (no equivalence review; `data/regression/`):

| Project       | Value mutants | Killed | Survived | NoCov | Stryker s | Runner s |
| ------------- | ------------: | -----: | -------: | ----: | --------: | -------: |
| scule         |            35 |     17 |       18 |     0 |         6 |       27 |
| ufo           |            25 |     20 |        5 |     0 |        13 |        8 |
| zustand       |             2 |      1 |        1 |     0 |        61 |        6 |
| mantine-hooks |            44 |     26 |        8 |    10 |        17 |      257 |
| ahooks        |             3 |      1 |        2 |     0 |        47 |       20 |
| hono          |           139 |    130 |        8 |     1 |       459 |     1473 |

On these projects the runner is also slower than Stryker where module-level sites or a whole-suite
command dominate (mantine: its test command names the package directory, so selection cannot
narrow it; hono). ahooks' runner used `vitest run --project ahooks`: two test files of another
package in its workspace fail at the pin.

## Failures and limits

- **h3** was not run (deviation 2). Its guarantees are frozen in `patches/`.
- **neverthrow** has no value site in its scope (the issue's "check on noise"): 0 value mutants.
- **valibot**: all 51 value mutants killed.
- Nine harness deviations were needed during the runs (protocol, Deviations 1–9). Four are runner
  fixes (symbolic links in sandboxes; whole-suite runs one at a time; a timed-out run repeated
  alone; `{files}` in the baseline run); the others are project settings (watchman, jest
  `projects`, a built-package test, a variadic jest flag, links that broke snapshot names). Each
  affected run was repeated, except where noted.
- One reviewer judged equivalence, the author of the feature. Every verdict has a reason.
- Stryker's own wall-clock varied between runs (es-toolkit 95 s in the run stopped by deviation 5,
  62 s in the repeated one); some short manual test runs overlapped with Stryker or runner runs.
- The runner starts the test command once per mutant; Stryker keeps runners alive. C3 measures that
  as it is.

## Issue candidates

1. **Runner: select tests for module-level sites.** A site in a module-level constant has no
   Stryker mutant with `coveredBy`; the runner falls back to the whole suite. Using the tests that
   cover the units reading the constant (`Unit.constantRanges`) would have kept es-toolkit near its
   other projects. This is the change that decides C3.
2. **Skip log and environment strings.** `debug(…)`, `logger.*(…)` arguments and the debug
   namespace (express-rate-limit, 21) and `process.env.NODE_ENV` comparison strings (jotai, 9) are
   skipped like `console.*`; error-message constants (`*_ERROR_MESSAGE`, cron-parser) like thrown
   messages.
3. **Runner: test commands with variadic flags.** Appended test files are swallowed by flags such as
   jest's `--testPathIgnorePatterns`; document `{files}` and warn when the command has no
   placeholder and ends in a flag.
4. **Stryker scope vs. value sites.** Value sites follow the constants a unit reads into other
   files; Stryker's `mutate` does not. Report value mutants outside the Stryker report's files as
   such in the Step Summary.
