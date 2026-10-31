# specgate

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
  or just `<id> …` inside `describe("Target") > describe("operation")`.
- A guarantee may mention only what its caller can observe: parameters, `result`, ports declared
  in `@uses` / `@modifies` (and their members), vocabulary from `@entity` schemas, and guarantees of
  other **public** operations (`QuestCompletionService#checkActivityConstraints.err.limit`,
  `#redeem.err.*`). Anything else is reported as an unresolved identifier.
- **Provenance** is recorded per guarantee from git: the commit that introduced it, the one that
  last changed it, and the PR number parsed from the squash-merge subject. That is how
  requirements are joined to code **without writing tracker ids into sources**; the join
  PR → ticket → frozen requirement lives in whatever consumes the IR.

## Install

```bash
bun add -d specgate
bunx specgate init --adapter vitest --ci
```

`init` writes `tsdoc.json` (extending `specgate/tsdoc.json`), `specgate.config.ts` and, with
`--ci`, a GitHub Actions workflow that publishes the Step Summary and SARIF.

```ts
// specgate.config.ts
import { dddTs, defineConfig } from "specgate";

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

| Command             | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Deterministic |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `specgate init`     | tsdoc.json, config skeleton, CI workflow (`--ci`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | yes           |
| `specgate scaffold` | For operations without guarantees: TSDoc skeleton filled from the signature (`@param`, `@returns`), the body (`@throws` from `throw new X`, `@uses` from the ports actually called) and a `@guarantee TODO` placeholder. Never writes prose.                                                                                                                                                                                                                                                                                                | yes           |
| `specgate gen`      | One `test()` per guarantee in the mirror path. Fills what tags and types determine: `@throws` → `toThrow(X)` skeleton; `@uses` → stubs, a fake clock and a fault-injecting transaction runner (`specgate/runtime`); `frame` → untouched-port assertion; `atomic` / `idempotent` → skipped skeletons awaiting contract fakes; `@example // =>` → `*.doctest.test.ts`; `@entity` + `@invariant` → `*.property.test.ts` (fast-check). Everything else is `test.todo`. Hand-edited files are only appended to; generated files are overwritten. | yes           |
| `specgate check`    | Rules below. Writes `.specgate/report.json` (IR), `summary.md` (GitHub Step Summary), `report.sarif`.                                                                                                                                                                                                                                                                                                                                                                                                                                       | yes           |
| `specgate docs`     | Markdown per source file: what (guarantees ↔ tests), why (`@remarks`), how (ports and operations actually called, extracted from the implementation), plus `index.md` and `vocabulary.md`.                                                                                                                                                                                                                                                                                                                                                  | yes           |

### Rules

| Rule                                              | Default | Meaning                                                                                            |
| ------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `operation-no-guarantee`                          | fail    | A public operation has no `@guarantee` / `@throws`                                                 |
| `guarantee-placeholder`                           | fail    | A `TODO` id is still there                                                                         |
| `guarantee-id-invalid` / `guarantee-id-duplicate` | fail    | Id does not match `ids.pattern`, or repeats within the unit                                        |
| `guarantee-no-test`                               | fail    | No test names the guarantee key                                                                    |
| `test-orphan`                                     | fail    | A test names a key that no guarantee has                                                           |
| `identifier-unresolved`                           | fail    | A code-shaped token in the statement is not a parameter, declared port, entity or public operation |
| `tsdoc-syntax`                                    | fail    | Undefined tags or malformed TSDoc (HTML/escape pedantry is ignored)                                |
| `operation-removed`                               | fail    | An operation in the previous report is gone and nothing `@supersedes` it                           |
| `guarantee-changed-test-unchanged`                | warn    | Statement hash changed, linked tests did not (needs a previous report)                             |
| `impl-changed-spec-unchanged`                     | warn    | Implementation hash changed, guarantees and tests did not                                          |
| `uses-mismatch`                                   | warn    | Ports called (including through private helpers) differ from `@uses` / `@modifies`                 |
| `env-input-direct`                                | warn    | `Date.now`, `new Date`, `Math.random`, `fetch`, … used directly instead of through a port          |
| `test-todo`                                       | warn    | A linked test is still `test.todo`                                                                 |

Severity per rule is configuration (`fail` / `warn` / `info` / `off`). In `mode: "advisory"` the
exit code is always 0; `--strict` or `mode: "blocking"` exits 1 on any `fail`.

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
stubs in `specgate/runtime` record calls so the frame can be asserted today; atomicity and
idempotence need fakes that pass the port's own contract suite, which `gen` emits as the test
skeleton for a `@port` interface.

## Writing TSDoc that parses

TSDoc treats `@word` anywhere as a tag and `{` as the start of an inline tag. Put tag names and
code in backticks (`` `@modifies` ``), and use fenced code blocks for `@example`. `<` and `>` in
prose are fine.

## IR

`schema/ir.schema.json` is the contract for consumers (regenerate with `bun run schema:emit`).
It carries units, guarantees with references and provenance, tests, vocabulary, findings and a
summary. Nothing in it refers to TypeScript syntax or to a tracker.

## Development

```bash
bun install
bun run test        # unit + integration (runs the full flow on tests/fixtures/shop)
bun run typecheck
bun run lint
```

The fixture is a flat `src/` + jest project with English prose so that assumptions from any one
company cannot hide in the core.

## Status

0.1.0. The public API (`analyze`, `defineConfig`, `dddTs`, `specgate/runtime`) and the IR are
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
