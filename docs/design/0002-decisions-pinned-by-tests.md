# 0002 — Decisions pinned by tests

Status: accepted (phase 1) · Issues: #31 (phase 1), #32 (phase 2: mutation report)

## Problem

`decision-unspecified` asks one question: is a value the implementation commits to named in the
contract? It never asks whether a linked test uses that value, and the IR kept only a title and a
body hash per test, so the information was not there.

The rule did not see values held in module-level collections either:

```ts
export const DENIED_PATHS: readonly string[] = ["/organization/create" /* 25 more */];
export const isDenied = (path: string) => DENIED_PATHS.includes(normalize(path));
```

The array is outside the unit body, and `includes` was not a comparison the walker recorded, so
the list produced no decision at all.

In a pilot on two internal packages, every test was linked, and Stryker was then run on both.
Eighteen of the 26 elements of a deny list like the one above could be deleted with every test
still green: the test listed 8 of the paths. specgate reported nothing. Three
`decision-unspecified` findings were false positives: the value was tested but not written in
the contract.

## Decision

Phase 1 stays static and deterministic. specgate never runs tests. Phase 2 (#32) reads a
mutation report that another tool produced.

### Test literals in the IR

While extracting tests, collect the literal values a test uses (`TestCase.literals`):

- non-empty strings, template-literal parts with a word character, numbers other than `0`,
  `1`, `-1` (as `String(n)`)
- from the test callback, the `each` table of the test (array and tagged-template tables), the
  tables of enclosing `describe.each`, and module-level `const` declarations of the same test
  file that those reference by name (one hop)
- never from the title
- at most `tests.literalLimit` (1000) per test

`TestCase.iterates` records imported constants the test takes its cases from: the `each`
argument, `for…of` (also over `Object.keys/values/entries(…)`), the receiver of `forEach` /
`map` / `flatMap` / `every` / `some` / `filter`, and expectations derived with `new Set(X)`,
`new Map(X)`, `Array.from(X)` or `[...X]`. `from` is the module, relative to root when the relative import
resolves to a file, the specifier as written otherwise.

### Membership decisions

`DecisionKind` gains `"member"`. Inside a unit body (and the helpers the walker already follows),
one decision is recorded for each literal element of a module-level `const` in any module that
the unit tests membership in:

| Collection                                      | Probes                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| array literal, `new Set([...])`, `new Map(...)` | `includes`, `indexOf`, `lastIndexOf`, `has`                                                                                                         |
|                                                 | `some` / `find` / `findIndex` / `findLast` / `findLastIndex` whose callback compares its parameter with `===`, `startsWith`, `endsWith`, `includes` |
| object literal (keys)                           | `v in X`, `Object.hasOwn(X, v)`, `X.hasOwnProperty(v)`                                                                                              |

- `as const`, `satisfies` and type annotations are looked through.
- A spread of another such constant is followed. Each element is attributed to the constant it
  is written in (`Decision.collection: { name, file }`), and `names` lists both the collection the
  unit probes and that constant.
- `Decision.probe` records how the input is compared: `exact`, `prefix`, `suffix`, `contains`.
- At most `decisions.collectionLimit` (500) elements per collection. Beyond that, one
  `decision-collection-truncated` (info) finding names the collection.

A `member` decision is named in the contract when a guarantee names a collection in a code span,
through the existing `names` check. Members that are not named are reported by
`decision-unspecified` **once per collection**, not once per element, so an upgrade does not turn
one unnamed list into dozens of findings.

### Rules

| Rule                            | Default | Meaning                                                                                                                                                           |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision-untested`             | warn    | The decision is named in the contract, the unit has linked tests, and none of them writes the value                                                               |
| `test-tautology`                | warn    | A linked test takes its cases from the collection the unit tests membership in. It passes whatever the collection holds                                           |
| `decision-unspecified`          | warn    | Unchanged, except: when a linked test writes the value, the message gains `(a linked test uses it)` and the severity is one step lower (fail → warn, warn → info) |
| `decision-collection-truncated` | info    | A collection was cut at `decisions.collectionLimit`                                                                                                               |

Linked tests of a unit are the tests whose key names the unit, plus those of every surface unit
that reaches it through calls (the same transitive callers as the contract corpus). `todo` and
`skip` tests do not count.

Matching a value against literals:

- numbers by value (`86_400_000` = `8.64e7`)
- `boundary`: the value or the value ± 1
- `output`: containment, since outputs are often asserted inside longer strings
- `member`: by the probe. A prefix list is pinned by a longer path that starts with the element
- anything else: equality

`decision-untested` does not fire where `decision-unspecified` fires. A `member` element reached
from several units (through a spread) counts as used when a test of any of them uses it, and is
reported once, on a unit in the collection's own module when there is one.

`test-tautology` looks at the linked tests of a unit that checks membership in the collection. A
test keyed to another unit may walk the list to check a property of the list itself ("every
element exists in the route table"), which is not tautological. Iterating does not count as
using the elements, so a tautological test leaves both findings, and listing the elements as
literals clears both.

## Changes from the proposal, after a prototype

A prototype was run on the pilot, before and after the test fix that listed all 26 elements.
The fixture of acceptance test A repeats that shape.

- Before the fix, 18 `decision-untested` findings appeared on the deny list, exactly the 18
  elements Stryker had found. After the fix there were 0.
- Of the other findings, 31 were real holes and 6 were false positives. Each was checked by
  deleting or changing the value and running the tests. The false positives were values the
  test reaches through a route-table lookup, or through a fixture in another file.

The prototype changed three things:

1. **Probe-aware matching.** With exact equality, every element of a prefix list
   (`some((p) => path.startsWith(p))`) was a false positive. With prefix matching, only an
   element that no test path starts with remained, and it was a real hole.
2. **One report per element.** A list spread into another (`DENIED = [...SECOND_FACTOR, …]`)
   doubled every finding. Usage is now pooled across units, and the finding is reported once.
3. **Unnamed members grouped** per collection in `decision-unspecified` (see above).

The prototype also suggested checking `test-tautology` over every test, after it missed a
`for (const x of LIST)` in a test keyed to another unit. With the full implementation, every
test it added checked that each element exists in a route table, which is not tautological. The
rule stays on linked tests. Instead, expectations derived from the constant (`new Set(LIST)`)
count as iteration, and that found the case the prototype had missed through the unit's own test.

## Non-goals and limits

- Proving that a test **asserts** a value. A literal used only as input still counts. Phase 2
  answers that when it matters.
- A value built at run time (`` `/org/${op}` ``) is missed, except template parts with a word
  character.
- A value reached through a lookup (a route manifest maps a path to an operation id), or held
  in a fixture in another file, is missed. Use `decisions.ignore`, or accept the finding.
- Membership detection is syntactic. A collection passed to a helper in another module and
  checked there is not seen. A local (non-module) array is not a collection.
- Large generated collections can produce many decisions. Put the collection name in
  `decisions.ignore`, or lower `decisions.collectionLimit`.
