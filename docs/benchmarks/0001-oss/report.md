# Benchmark 0001 — results

specgate 0.5.0 and Stryker on five public TypeScript projects, plus `vercel/ms` as calibration.
Protocol: [protocol.md](protocol.md) (pre-registered, with dated deviations at the end).
Projects, commits and scopes: [projects.md](projects.md). Raw data: [data/](data/).
Run on 2026-11-06, Apple M3 Max, macOS 27, Node 24.3.0.

## Answer in one paragraph

On these five projects, with guarantees written blind from public docs and every test linked by
title, the static rules of specgate found **2 real holes, and Stryker also expressed both**
(a surviving mutant on the same literal). The headline number, real holes that specgate finds
and no surviving Stryker mutant expresses, is **0**. It is 0 on the calibration project too
(14 real holes, all matched by surviving `StringLiteral` mutants). The static rules were precise
in 2 of 15 judged findings (13%); 5 of the 15 were not applicable (type-only or equivalent
changes). Stryker left 164 non-equivalent survivors; the static rules pointed at 6. With the
Stryker report loaded, specgate attached 90 of the 164 (55%) to a unit in a finding and named a
decision for 15 (9%). One real hole that neither tool reported was found by a supplementary check
outside the protocol: an element of a module-level list whose deletion keeps scule's tests green.
These are small numbers from five projects. They do not support a general claim in either
direction.

## Projects

| Project       | Kind                        | Units (with guarantees) | Guarantees | Decisions | Linked tests | Mutants | Survived + NoCoverage | Equivalent |
| ------------- | --------------------------- | ----------------------- | ---------- | --------- | ------------ | ------- | --------------------- | ---------- |
| scule         | utility                     | 11 (10)                 | 20         | 4         | 11           | 78      | 6                     | 1          |
| ufo           | parsing                     | 9 (9)                   | 16         | 5         | 5            | 228     | 32                    | 11         |
| zustand       | state                       | 4 (4)                   | 23         | 0         | 165          | 245     | 30                    | 2          |
| mantine hooks | React hooks                 | 6 (6)                   | 26         | 9         | 36           | 221     | 84                    | 6          |
| ahooks        | React hooks                 | **0**                   | 0          | 0         | 7 (orphaned) | 53      | 2                     | 2          |
| hono          | server middleware           | 5 (5)                   | 28         | 11        | 72           | 445     | 45                    | 13         |
| **total**     |                             | 35 (34)                 | 113        | 29        | 296          | 1270    | 199                   | 35         |
| ms            | calibration (not in totals) | 4 (4)                   | 13         | 72        | 167          | 227     | 33                    | 3          |

"Linked tests" is the number of tests whose title names a guarantee key after the mechanical
renaming. ufo's tests mostly call other public functions (`withQuery`, `normalizeURL`, …) that
reach the parsers indirectly, so only 5 tests call an operation in scope directly. ahooks' 7 tests
are linked but have no unit to link to (see Applicability).

## 1. Precision of the static rules

Each finding was judged by the smallest change it implies, in a throwaway copy, with the project's
tests run as Stryker runs them (deviation 4). Verdicts: `data/<project>/oracle/static-verdicts.json`.

| Project                  | Rule                   | Judged | Real hole | Pinned | Not applicable |
| ------------------------ | ---------------------- | ------ | --------- | ------ | -------------- |
| scule                    | `decision-untested`    | 3      | 0         | 0      | 3              |
| scule                    | `decision-unspecified` | 1      | 0         | 0      | 1              |
| ufo                      | `decision-unspecified` | 4      | 2         | 1      | 1              |
| hono                     | `decision-unspecified` | 7      | 0         | 7      | 0              |
| zustand, mantine, ahooks | any                    | 0      | –         | –      | –              |
| **total**                |                        | **15** | **2**     | **8**  | **5**          |
| ms (calibration)         | `decision-untested`    | 36     | 14        | 22     | 0              |
| ms (calibration)         | `decision-unspecified` | 18     | 0         | 18     | 0              |

`test-tautology` produced no finding in any project.

- **scule, 4 not applicable.** All four are the string `"normalize"` in a type position
  (`as PascalCase<T, UserCaseOptions["normalize"]>`). specgate records it as an `output` decision.
  It is erased at run time; changing it fails only `vitest --typecheck`.
- **ufo, 2 real.** `parseQuery` skips the keys `"__proto__"` and `"constructor"`; no test sends
  either, so the guard can be changed or removed with every test green. 1 pinned (`"file:"` in
  `parseURL`). 1 not applicable: `s.length < 2` on a regex match array that always has length 0
  or 3, so `<=` is equivalent.
- **hono, 7 pinned.** Two are warnings on implementation arithmetic (`i * 2 + 2`, a CSP index) and
  a regex replacement (`'$1-$2'`); five are `info` findings that already say "(a linked test uses
  it)", and the tests do pin them.
- **ms (calibration), 14 of 54.** The 14 real holes are unit aliases (`yrs`, `hour`, `secs`, …)
  that no test parses. 19 of the 22 pinned `decision-untested` findings are aliases that tests do parse,
  but inside a longer literal (`"10 years"`, `"10 hours"`); `match` decisions are compared by
  equality, so the literal does not count. The other 3 are the day constant and boundary
  (86400000), which tests reach through `"1d"`. All 18 `decision-unspecified` findings were pinned.
  The README's earlier "7 of 7" on ms used different guarantees: these name every unit alias,
  which turns each alias into a named decision that `decision-untested` then checks.

## 2. Unique contribution (headline)

Real holes from the static rules that no `Survived` or `NoCoverage` mutant expresses:

| Kind                                 | Count |
| ------------------------------------ | ----- |
| an element removed from a collection | 0     |
| a value the contract does not name   | 0     |
| other                                | 0     |
| **total**                            | **0** |

Both real holes in ufo had surviving mutants on the same literal (mutants 178 and 181 replace
`"__proto__"` and `"constructor"` with `""`, plus condition and logical-operator mutants on the same
line). On ms, the 14 real holes are exactly the 14 surviving `StringLiteral` mutants on the
`case` labels.

No finding in any project was about a collection. In the five projects, specgate extracted no
`member` decision at all (see Applicability).

### Supplementary: holes neither tool reported (outside the protocol)

To see what the "removing an element" category looks like here, each element of the module-level
lists in scope was deleted one at a time and the tests run
(`data/*/oracle/supplementary-*.json`). This is not a pre-registered metric.

| Collection                                     | Elements | Deletion keeps tests green |
| ---------------------------------------------- | -------- | -------------------------- |
| scule `STR_SPLITTERS` (`["-", "_", "/", "."]`) | 4        | **1** (`"."`)              |
| hono cors default `allowMethods`               | 7        | 0                          |
| hono secure-headers `HEADERS_MAP` entries      | 12       | 0                          |

Deleting `"."` from scule's default splitters is a real hole. Stryker created no mutant on that
line. specgate did not see the list, because `splitByCase` probes it through a local alias
(`const splitters = separators ?? STR_SPLITTERS; splitters.includes(char)`), which 0.5.0 does not
follow (issue candidate 4).

## 3. The converse: survivors the static rules miss

| Project   | Non-equivalent survivors | Pointed at by a static finding | Not pointed at |
| --------- | ------------------------ | ------------------------------ | -------------- |
| scule     | 5                        | 0                              | 5              |
| ufo       | 21                       | 6                              | 15             |
| zustand   | 28                       | 0                              | 28             |
| mantine   | 78                       | 0                              | 78             |
| ahooks    | 0                        | 0                              | 0              |
| hono      | 32                       | 0                              | 32             |
| **total** | **164**                  | **6**                          | **158**        |
| ms        | 30                       | 15                             | 15             |

By kind (`data/*/oracle/survivors.json`), the 164 are 50 changed values, 47 removals (a block,
call or dependency array emptied), 55 changed conditions, 2 boundaries and 10 others. The static
rules can in principle address only the value and boundary kinds (52 of the 164). The 6 survivors
they pointed at are all on ufo's `__proto__` / `constructor` line. The rest sit in code where no decision was extracted: closures
(zustand, all hooks), default parameters, module-level regexes and option objects.

## 4. Explanation coverage (with `mutation.report`)

| Project   | Non-equivalent survivors | In a finding on a unit | Message names a decision |
| --------- | ------------------------ | ---------------------- | ------------------------ |
| scule     | 5                        | 4                      | 0                        |
| ufo       | 21                       | 17                     | 7                        |
| zustand   | 28                       | 10                     | 0                        |
| mantine   | 78                       | 28                     | 4                        |
| ahooks    | 0                        | 0                      | 0                        |
| hono      | 32                       | 31                     | 4                        |
| **total** | **164**                  | **90 (55%)**           | **15 (9%)**              |
| ms        | 30                       | 30                     | 17                       |

Where the 74 unexplained survivors are:

- **mantine, 50:** all in `useOs`, which has no test. specgate counts its 52 NoCoverage mutants
  on the unit (`units[].mutation`) and reports `guarantee-no-test` instead of one finding per
  mutant, by design.
- **zustand, 18:** all in `persistImpl`. `persist` is exported as
  `persistImpl as unknown as Persist`; specgate makes a unit with no body, so neither decisions
  nor mutants reach it (issue candidate 2).
- **ufo, 4:** three NoCoverage mutants in `parseAuth` and `parseQuery`, which have no linked test
  that specgate read, so 0003 counts them on the unit and leaves them to `guarantee-no-test`; one
  module-level `Symbol.for` key. (`parseQuery`'s one link is in `test/types.test-d.ts`, which the
  config's `tests.include: ["test/**/*.test.ts"]` does not read.)
- **hono, 1; scule, 1:** module-level constants (`DEFAULT_OPTIONS`, the `titleCase` minor-word
  regex). Documented limit of 0003.

## 5. Applicability

| Project | Operations in scope  | Units | Decisions by kind                              | Units with no decision |
| ------- | -------------------- | ----- | ---------------------------------------------- | ---------------------- |
| scule   | 10 (+1 undocumented) | 11    | output 4 (all the type-position `"normalize"`) | 7 of 11                |
| ufo     | 9                    | 9     | match 4, boundary 1                            | 7 of 9                 |
| zustand | 4                    | 4     | none                                           | 4 of 4                 |
| mantine | 6                    | 6     | output 7, constant 2                           | 4 of 6                 |
| ahooks  | 3                    | **0** | –                                              | –                      |
| hono    | 5                    | 5     | match 5, output 5, constant 1                  | 2 of 5                 |

- **React hooks are the weak spot, and for two different reasons.** ahooks exports every hook as
  `export default`; specgate 0.5.0 makes no unit from a default export, reports the three doc
  comments as `guarantee-on-non-unit` and the surface as empty (issue candidate 1). mantine's
  named hooks become units, but their behaviour lives in `useState` / `useCallback` closures: 4 of
  6 hooks have no decision, and the 9 that exist produced no finding. Stryker found 78
  non-equivalent survivors there (30 removals, mostly emptied dependency arrays).
- **State code (zustand) gave no decision at all.** `createStore` and `shallow` are closures and
  iterator logic; `persist` is not followed (above).
- **Value-heavy code is where the rules fire:** ms (72 decisions), hono's header defaults, ufo's
  guards. Even there, the defaults hono documents are pinned by its tests.
- **Linking by title is fragile in two places:** computed titles (ufo, deviation 1) and
  `describe("cleanup")`, which specgate reads as a class name, so 9 zustand tests became
  `test-orphan` (issue candidate 6).

## 6. Cost

Same scope, same machine. specgate: median of three static runs. Stryker: one run, wall-clock.

| Project | specgate check (s) | Stryker (s) |
| ------- | ------------------ | ----------- |
| scule   | 1.14               | 4.4 (8.7.1) |
| ufo     | 1.04               | 8.2         |
| zustand | 1.42               | 45.0        |
| mantine | 6.77               | 17.7        |
| ahooks  | 2.39               | 17.8        |
| hono    | 1.59               | 13.1        |
| ms      | 1.13               | 11.6        |

Both are cheap at these scopes. specgate's time is dominated by building the TypeScript program
(mantine's is a large monorepo). Stryker's grows with the number of mutants and the cost of the
tests that cover them. Some Stryker runs overlapped with one-second specgate runs (deviation 5).

## Limits and caveats

- **Five projects, 15 judged static findings, 164 survivors.** Percentages are given for reading
  convenience only.
- **One author wrote all guarantees**, an AI agent, as the intended workflow assumes. Different
  guarantees change what is "named" and therefore which rule fires (the ms calibration shows this).
  The guarantees name concrete values only where the docs do; the docs of zustand and mantine name
  few.
- **Linking used a fallback** (an operation's first `ok.*` guarantee) for tests that matched no
  statement. That makes every exercising test count for `decision-untested`, which favours
  precision. It does not change Stryker.
- **Equivalence was judged by reading the code**, with reasons recorded per mutant. The judgments
  were made with model assistance and were not independently reviewed by a second reader. Where
  the static oracle and a survivor overlap (ufo `s.length < 2`), the two independent judgments
  agree. Five hono judgments assume callers respect the TypeScript option types; they are
  flagged in the file.
- **The oracle ignores type errors**, as Stryker does (deviation 4). Under `tsc`, the ms unit
  aliases and scule's type-position values are pinned by the type checker.
- **Scope.** Only the files in `projects.md`. Holes in code outside the scope, or reached only
  through other public functions (most of ufo's tests), are not counted.
- **Not measured:** authoring effort, the non-static rules (`guarantee-no-test`, `identifier-unresolved`, …),
  and whether specgate's naming of a decision helps a person fix a survivor faster.

## Issue candidates for specgate

Found during the benchmark, not fixed (protocol: the released tool is not changed).

1. **Default exports are not units.** `const useCounter = …; export default useCounter` and
   `export default function useBoolean` give no unit; their guarantees are reported as
   `guarantee-on-non-unit` and the run as `surface-empty`. Common in React code (ahooks: 0 units).
2. **A callable exported through a cast is not followed.** `export const persist = persistImpl as
   unknown as Persist` makes a unit with no body: no decisions, and the 20 surviving mutants in `persistImpl` are not mapped to any unit.
3. **Strings in type positions are `output` decisions.** `UserCaseOptions["normalize"]` inside an
   `as` cast produced 4 findings in scule, all not applicable.
4. **A collection probed through a local alias is missed.** `const splitters = separators ??
   STR_SPLITTERS; splitters.includes(c)` gives no `member` decision. This hid the one hole neither
   tool reported.
5. **`match` values are compared by equality with test literals.** A unit alias matched from a
   regex group (`"years"`) is not counted as used when the test writes `"10 years"`; 19 of the 36
   `decision-untested` findings on ms were pinned for this reason. Word-boundary containment for
   `match` decisions taken from a parsed input would remove them.
6. **A plain-identifier `describe` is read as the target class.** `describe("cleanup", …)` turned
   `createStore.ok.api …` into the key `cleanup#createStore.ok.api` and a `test-orphan`.
7. **Implementation arithmetic as `decision-unspecified`.** `i * 2 + 2` (an array index) and
   `'$1-$2'` (a regex replacement) are reported as unnamed values a contract should state; both were
   pinned and neither is something a caller can observe directly.
8. **An inline array probe is an `output`.** `['self', 'src'].includes(item)` gives two `output`
   decisions rather than `member` decisions.
9. **An operation's own name in prose is unresolved.** "joins the parts by camelCase" in
   `camelCase`'s guarantee gives `identifier-unresolved`.

An earlier version of this list had a tenth candidate, "mutants in parameter defaults are not
mapped". It was wrong: those mutants are inside the unit's range, in units with no linked test
(see section 4).

## Reproducing

`scripts/run.sh <project> <work-dir>` clones the project at its commit, applies both patches,
installs dependencies with lifecycle scripts off, runs the tests, Stryker and specgate, and writes
`data/<project>/`. The oracle is `scripts/oracle.mjs` with the case files in
`data/<project>/oracle/*-cases.json`; `scripts/metrics.mjs data` recomputes `data/metrics.json`.
hono needs pnpm 12 (`PNPM=<path>`); scule uses Stryker 8.7.1 (`scripts/config/scule/stryker.version`).
