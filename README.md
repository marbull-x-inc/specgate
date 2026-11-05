# specgate

[![ci](https://github.com/marbull-x-inc/specgate/actions/workflows/ci.yml/badge.svg)](https://github.com/marbull-x-inc/specgate/actions/workflows/ci.yml)
[![release](https://github.com/marbull-x-inc/specgate/actions/workflows/release.yml/badge.svg)](https://github.com/marbull-x-inc/specgate/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/%40marbull-x-inc%2Fspecgate)](https://www.npmjs.com/package/@marbull-x-inc/specgate)
[![license](https://img.shields.io/github/license/marbull-x-inc/specgate)](LICENSE)

A consistency gate between **TSDoc guarantees**, **tests** and **implementation** for TypeScript
codebases. It answers one question in CI: does every public operation say what it guarantees,
does a test exist for each guarantee, and did the three move together?

specgate is deliberately ignorant of your company. It does not know your issue tracker, your
layer names, your test-title conventions or your runner. Those come from a preset and a small
config. Its product is an **IR** (`schema/ir.schema.json`): a language-neutral JSON document
that dashboards and spec indexes consume without reading your sources.

## How it works

```
/**
 * Places an order and notifies the account.
 * @remarks The notification follows the store so a failed store never produces a message.
 * @param items - at least one item
 * @throws {@link EmptyOrderError} err.empty   items is empty; no state changes
 * @uses TransactionRunner, OrderRepository, NotificationGateway, Clock
 * @modifies OrderRepository, NotificationGateway
 * @guarantee ok.stored    after the call OrderRepository holds an order with status PLACED
 * @guarantee ok.notified  NotificationGateway recorded exactly one orderPlaced(accountId, result)
 * @guarantee atomic       when any port fails, OrderRepository and NotificationGateway are unchanged
 */
async placeOrder(accountId: string, items: OrderItem[]): Promise<string>
```

```ts
test("PlaceOrderUseCase#placeOrder.ok.stored after the call OrderRepository holds …", …);
```

- A **unit** is an operation another module can call: an exported function, a public method of
  an exported class, or an interface marked `@port`. Private helpers are part of the operation
  that reaches them and never become units. With `surface.mode: "referenced"` (default) an
  export must also be imported by a non-test module to count.
- A **guarantee** is one `@guarantee <id> <statement>` or `@throws {@link Error} <id> <statement>`.
  Ids are typed slugs by default (`ok.*`, `err.*`, `atomic`, `frame`, `idempotent`); the shape is
  a regular expression in the config, so `G1`-style numbering works too.
- A **test** links to a guarantee by title only: `Target#operation.<id> …`, `operation.<id> …`,
  or just `<id> …` inside `describe("Target") > describe("operation")` A category prefix configured
  in `tests.prefixes` (`正常系: Target#operation.<id> …`) may come first.
- A guarantee may mention only what its caller can observe: parameters, `result`, ports declared
  in `@uses` / `@modifies` (and their members), vocabulary from `@entity` schemas, and guarantees of
  other **public** operations (`QuestCompletionService#checkActivityConstraints.err.limit`,
  `#redeem.err.*`; a `Target#operation` whose class is in the program but outside the surface
  resolves as an external operation). Words in backticks are code spans and are not resolved.
  Anything else is reported as an unresolved identifier.
- **Provenance** is recorded per guarantee from git: the commit that introduced it, the one that
  last changed it, and the PR number parsed from the squash-merge subject. That is how
  requirements are joined to code **without writing tracker ids into sources**; the join
  PR → ticket → frozen requirement lives in whatever consumes the IR.

## Install

```bash
bun add -d @marbull-x-inc/specgate
bunx specgate init --adapter vitest --ci
```

`init` writes `tsdoc.json` (extending `@marbull-x-inc/specgate/tsdoc.json`), a config and, with
`--ci`, a GitHub Actions workflow that publishes the Step Summary and SARIF (every action pinned
by SHA). The config is `specgate.config.ts` when the package is installed and
`specgate.config.json` otherwise, so that trying specgate through `bunx` / `npx` before adding
it works; `--format ts|json` chooses explicitly. When several config files exist, the first of
`specgate.config.{ts,mts,js,mjs,json}` is used and the others are named on stderr.

```ts
// specgate.config.ts
import { dddTs, defineConfig } from "@marbull-x-inc/specgate";

export default defineConfig({
  presets: [dddTs],
  surface: { include: ["src/application/**/*.ts", "src/domain/**/*.ts"] },
  tests: {
    include: ["tests/**/*.test.ts"],
    adapter: "vitest",
    mirror: { from: "src", to: "tests", suffix: ".test.ts" },
  },
  mode: "advisory", // "blocking" once the baseline is clean
  rules: { "env-input-direct": "fail" },
});
```

## Commands

| Command             | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Deterministic |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `specgate init`     | tsdoc.json, config skeleton, CI workflow (`--ci`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | yes           |
| `specgate scaffold` | For operations without guarantees: TSDoc skeleton filled from the signature (`@param`, `@returns`), the body (`@throws` from `throw new X`, `@uses` from the ports actually called) and a `@guarantee TODO` placeholder. Never writes prose.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | yes           |
| `specgate gen`      | One `test()` per guarantee in the mirror path. Fills what tags and types determine: `@throws` → `toThrow(X)` skeleton; `@uses` → stubs, a fake clock and a fault-injecting transaction runner (`@marbull-x-inc/specgate/runtime`); `frame` → untouched-port assertion; `atomic` / `idempotent` → skipped skeletons awaiting contract fakes; `@example // =>` → `*.doctest.test.ts`; `@entity` + `@invariant` → `*.property.test.ts` (fast-check). Everything else is `test.todo`. Hand-edited files are only appended to (with the same skeletons and the imports they need); generated files are overwritten. Run the project formatter after `gen` for lines longer than `tests.lineWidth`. | yes           |
| `specgate check`    | Rules below. Writes `.specgate/report.json` (IR), `summary.md` (GitHub Step Summary), `report.sarif`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | yes           |
| `specgate docs`     | Markdown per source file: what (guarantees ↔ tests), why (`@remarks`), how (ports and operations actually called, extracted from the implementation), plus `index.md` and `vocabulary.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | yes           |

### Rules

| Rule                                              | Default | Meaning                                                                                                                                                                                   |
| ------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation-no-guarantee`                          | fail    | A public operation has no `@guarantee` / `@throws`                                                                                                                                        |
| `guarantee-placeholder`                           | fail    | A `TODO` id is still there                                                                                                                                                                |
| `guarantee-id-invalid` / `guarantee-id-duplicate` | fail    | Id does not match `ids.pattern`, or repeats within the unit                                                                                                                               |
| `guarantee-no-test`                               | fail    | No test names the guarantee key                                                                                                                                                           |
| `test-orphan`                                     | fail    | A test names a key that no guarantee has                                                                                                                                                  |
| `identifier-unresolved`                           | fail    | A code-shaped token in the statement is not a parameter, declared port, entity or public operation                                                                                        |
| `tsdoc-syntax`                                    | warn    | Undefined tags or malformed TSDoc (HTML/escape pedantry is ignored; `tsdoc.jsdoc` accepts JSDoc)                                                                                          |
| `operation-removed`                               | fail    | An operation in the previous report is gone and nothing `@supersedes` it                                                                                                                  |
| `guarantee-changed-test-unchanged`                | warn    | Statement hash changed, linked tests did not (needs a previous report)                                                                                                                    |
| `impl-changed-spec-unchanged`                     | warn    | Implementation hash changed, guarantees and tests did not                                                                                                                                 |
| `uses-mismatch`                                   | warn    | Ports called (including through private helpers) differ from `@uses` / `@modifies`                                                                                                        |
| `env-input-direct`                                | warn    | `Date.now`, `new Date`, `Math.random`, `fetch`, … used directly instead of through a port                                                                                                 |
| `test-todo`                                       | warn    | A linked test is still `test.todo`                                                                                                                                                        |
| `decision-unspecified`                            | warn    | The implementation commits to a value (boundary, constant, output, match, member) no guarantee names; one step lower, with "(a linked test uses it)", when a linked test writes the value |
| `decision-untested`                               | warn    | A value the contract names that no linked test writes as a literal: a test cannot fail when it changes                                                                                    |
| `test-tautology`                                  | warn    | A linked test takes its cases from the collection the unit checks membership in, so removing an element cannot fail it                                                                    |
| `decision-collection-truncated`                   | info    | A collection holds more elements than `decisions.collectionLimit`; the rest are not checked                                                                                               |
| `mutant-survived`                                 | warn    | With `mutation.report`: a mutant no linked test failed on (Survived), or one no test ran in a unit the tests do run (NoCoverage). Names the decision on that line                         |
| `unit-not-executed`                               | warn    | With `mutation.report`: a unit has linked tests, yet every mutant in it is NoCoverage (the tests stub it or call another implementation)                                                  |
| `mutation-report-unreadable`                      | warn    | `mutation.report` is missing, not JSON, or not a mutation-testing-report-schema report; the mutation rules did not run                                                                    |
| `guarantee-known-violation`                       | warn    | A linked test is `test.failing` / `test.fails`: the implementation is known not to keep it                                                                                                |
| `entry-unmapped`                                  | info    | A `package.json#exports` subpath points only to build output; map it with `surface.entries`                                                                                               |
| `guarantee-on-non-unit`                           | fail    | A `@guarantee` sits on a declaration that is not a unit (not exported, private, a type, …)                                                                                                |
| `surface-empty`                                   | warn    | No unit was extracted (the message lists the usual causes)                                                                                                                                |

Severity per rule is configuration (`fail` / `warn` / `info` / `off`). In `mode: "advisory"` the
exit code is always 0; `--strict` or `mode: "blocking"` exits 1 on any `fail`.

### Adopting in a repository with history

On code that was not written for specgate, `check` starts with many findings. Three settings
make the first run useful instead of red:

- `tsdoc: { jsdoc: true }` accepts JSDoc conventions (`@name`, `@category`, `@param {type}`, `{`
  in examples) without messages; `tsdoc-syntax` is `warn` by default anyway.
- `@throws` written without an id gets one (`@throws RangeError if …` → `err.range-error`), so
  the contracts already written count as guarantees (`ids.deriveThrows`, on by default).
- `specgate check --accept-baseline` records the current `fail` / `warn` findings in
  `specgate.accepted.json` (commit it). Later runs report those as `info` with `accepted: true`
  and fail only on new ones, so `mode: "blocking"` can be switched on the same day. Findings are
  matched by rule, file, unit, guarantee, test and message, not by line; rerun
  `--accept-baseline` after fixing some to shrink the file.

`scaffold` seeds the first guarantee from an existing `@returns` and does not repeat a
documented `@throws`.

### Guarantees on types and package entries

Some promises are not about a call:

- **What a type accepts or rejects.** An exported type alias or non-`@port` interface whose doc has `@guarantee` is a `type` unit (`Merge.ok.left-wins`). There, `ok.*` means the stated type expression compiles, and `err.*` means it is a type error.
- **What a package entry exposes.** The `@packageDocumentation` comment of an entry module is an `entry` unit (`entry#main.ok.esm`, `entry#runtime.ok.esm`). Entry modules come from `package.json#exports`, through a condition that points to a source file (`bun`, `source`, …), or else from `surface.entries`.

No test runner type-checks the tests themselves, so `gen` writes these tests with helpers from `@marbull-x-inc/specgate/typecheck`:

- **`checkTypes(source, { from })`** runs the TypeScript checker on a snippet, with the repository's compiler options. Type guarantees go to `*.types.test.ts`. The snippet starts as `todoSnippet(…)`, which throws, so the test fails until the author writes the type expression.
- **`loadEntry(subpath, { root, condition })`** imports or requires the built package by its own name, in a child Node process. Entry guarantees go to `*.entry.test.ts`, skipped until the build runs before the tests.

Design: `docs/design/0001-type-and-entry-units.md`.

### Linked is not the same as tested

The other rules check that every guarantee has a test. They cannot tell whether the test pins
down what the implementation decided: a test written from a contract that never says "a week is
7 days" passes whether the code multiplies by 7 or by 8. `decision-unspecified` closes part of
that gap statically. It collects the values an operation commits to (compared boundaries,
computed constants, returned strings, values the input is matched against, following private
helpers and non-exported functions of the module) and reports those that no guarantee or
`@example` of the unit, or of a surface unit that calls it, names. Each finding is either a hole
in the contract (write the guarantee, then the test) or a value you accept as unspecified
(`decisions.ignore`).

Naming a value lets a test be written for it; only a test that uses it can fail when it
changes. `decision-untested` asks the second question: for each value the contract names, does a
test linked to the unit (or to a unit that calls it) write it as a literal? That includes each
element of a module-level collection the unit checks membership in (`DENIED.includes(path)`,
`PREFIXES.some((p) => path.startsWith(p))`), so a deny list whose test lists 8 of its 26 paths
gets 18 findings. A test that iterates the list itself (`it.each(DENIED)`) passes whatever the
list holds; `test-tautology` reports it. When `decision-unspecified` fires for a value a linked
test does write, the finding is one step lower and says so. Values a test reaches only through a
lookup (a route table, a fixture in another file) are not seen, so treat these findings as
hints too. Design: `docs/design/0002-decisions-pinned-by-tests.md`.

It matches by value, so it is a hint, not a proof: a value named for one purpose (`100` as an
example result) also counts for another (`100` as the input length limit), and a value named in
the contract may still be untested at a particular boundary. On `vercel/ms` with guarantees
written from the README only, the 7 findings were all real holes (week and month conversion,
their boundaries, the plural threshold) and covered 20 of the 44 mutants those tests missed.

### Reading a mutation report

The static checks above guess at the changes no test would notice. A mutation tool knows, and it
also sees changes that are not values: a flipped condition, a removed call, a reordered route.
specgate never runs mutants itself. Set `mutation.report` to the JSON report another tool wrote
in the same CI job (Stryker's `mutation.json`, or any tool that writes the
[mutation-testing-report-schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema)),
and run it before `check`:

```bash
npx stryker run --reporters json   # writes reports/mutation/mutation.json
npx specgate check                 # with mutation: { report: "reports/mutation/mutation.json" }
```

Each mutant is mapped to the unit whose lines it changed, to every unit that reaches it through a
private helper or same-module function, and to every unit with a `member` decision on the
collection it changed. `units[].mutation` holds the counts; the Step Summary shows them per unit
with a score (killed over killed, survived and not covered), and `specgate docs` adds them to
each unit's page and a score column to the index. `mutant-survived` reports each mutant
the linked tests let through, and `unit-not-executed` a unit that its tests never run. An
equivalent mutant (one no test can tell apart) is accepted with `check --accept-baseline`: the
fingerprint holds the unit, the mutator and the replacement but not the line, so it stays
accepted when code moves. specgate does not check that the report is newer than the sources.
Design: `docs/design/0003-mutation-report.md`.

## The coding procedure specgate assumes

1. **Read the ticket.** Requirements (acceptance criteria) and design decisions live in your
   tracker; nothing from there is copied into code.
2. **Vocabulary and ports first.** New entities and value objects are Zod schemas (or classes)
   with `@entity` and `@invariant`; new environment inputs are `@port` interfaces. `specgate docs`
   lists what already exists.
3. **Write the public signature.** Parameter and return types only; the body throws
   `not implemented`.
4. **Write the guarantees.** Summary, `@remarks` (why), `@param` constraints, `@returns`,
   `@throws`, `@guarantee` (one statement each, in vocabulary only), `@uses` / `@modifies`,
   `@example`. `specgate scaffold` fills the signature-derived part. `specgate check` must report
   no unresolved identifier.
5. **`specgate gen`.** Tests appear in the mirror path: doctest, property, `@throws` and port
   skeletons filled, the rest as `test.todo`.
6. **Fill the todos (red).** Arrange and assert; the tests fail.
7. **Implement (green).** Split the body however you like; private helpers are invisible to the gate.
8. **`specgate check`.** No `fail`; the IR is updated.
9. **Pull request.** The Step Summary lists the guarantees added or changed. Reviewers read the
   statements before the code.

Changing an existing operation starts at step 4: edit the statement first. `gen` adds a todo for
any new id, and `check` keeps warning that the guarantee changed while its tests did not until
the tests follow. Removing a guarantee removes its tests, or `@supersedes` hands them over.

## Side effects are state, not calls

Guarantees about repositories and gateways describe the **state of a declared port after the
call**, never which methods were invoked. `@modifies` is the frame; `atomic` means "all or
nothing under fault injection"; `idempotent` means "two calls leave the state of one". The
stubs in `@marbull-x-inc/specgate/runtime` record calls so the frame can be asserted today; atomicity and
idempotence need fakes with real state that pass the port's own contract, so `gen` emits those
two as skipped skeletons for you to finish. For a `@port` interface, `gen` currently emits one
`test.todo` per guarantee; generating a contract suite that runs the same tests against the
real implementation and an in-memory fake is planned.

## Writing TSDoc that parses

TSDoc treats `@word` anywhere as a tag and `{` as the start of an inline tag. Put tag names and
code in backticks (`` `@modifies` ``), and use fenced code blocks for `@example`. `<` and `>` in
prose are fine.

## Configuration

Every option, with defaults, is in [docs/config.md](docs/config.md).

## Example

[`examples/shop`](examples/shop) is a small order-taking domain (flat `src/`, jest, English
prose) with guarantees already written for some operations and none for others.
[`examples/shop-expected`](examples/shop-expected) is what `scaffold → gen → check → docs`
produce from it: the scaffolded TSDoc, the generated tests, the docs and the Step Summary.
The integration tests regenerate it on every run, so it never drifts from the code.

## Known limitations

- `surface.mode: "referenced"` sees named, namespace and re-exported imports. A class resolved
  only by a DI container through a string token, or loaded only by `import()`, is not counted as
  referenced; use `mode: "exported"` or `classPattern` for such modules.
- TSDoc parses `@word` anywhere as a tag and `{` as an inline tag. Put tag names and object
  literals in backticks or fenced code.
- Identifier resolution is lexical. A word that happens to be PascalCase and names a program
  type resolves even when it was meant as prose; `resolve.ignore` and `allowProgramTypes: false`
  tighten this.
- Windows paths are normalised to POSIX in the IR but the tool has only been exercised on
  macOS and Linux.
- Performance has been measured on single files (a 967-line use case in a 1,200-file monorepo
  checks in under 3 seconds). Whole-repository runs on large monorepos are not yet measured.

## IR

`schema/ir.schema.json` is the contract for consumers (regenerate with `bun run schema:emit`).
It carries units, guarantees with references and provenance, tests, vocabulary, findings and a
summary. Nothing in it refers to TypeScript syntax or to a tracker.

## Development

```bash
bun install
bun run verify          # lint + typecheck + test + build (what CI runs)
bun run example:refresh # regenerate examples/shop-expected after changing scaffold / gen / docs
bun run schema:emit     # regenerate schema/ir.schema.json after changing src/ir/schema.ts
```

The example is a flat `src/` + jest project with English prose so that assumptions from any one
company cannot hide in the core. See [CONTRIBUTING.md](CONTRIBUTING.md).

Requires Node 24+ (Node 26 is used in CI) or Bun 1.2+.

## Status

0.3.0. The public API (`analyze`, `defineConfig`, `dddTs`, `@marbull-x-inc/specgate/runtime`) and the IR are
expected to change before 1.0.

## Releasing

Releases are cut from `main` by a version tag; `.github/workflows/release.yml` verifies, builds,
publishes to npm with provenance (npm Trusted Publishing, no stored token) and creates the GitHub
Release.

```bash
bun run version:patch   # or version:minor / version:major — bumps package.json and tags vX.Y.Z
git push --follow-tags
```

The package ships `dist/` (ESM + `.d.ts`, built by `tsc`) so that Node runs it without a
TypeScript loader; under Bun the `bun` export condition points at `src/`.
