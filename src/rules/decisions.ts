import { decisionMentioned } from "../extract/decisions.ts";
import type { Decision, TestCase, Unit } from "../ir/schema.ts";

/**
 * Decision rules: is a value the implementation commits to named by the contract
 * (`decision-unspecified`), and does a linked test use it (`decision-untested`)?
 *
 * @remarks
 * Naming a value in a guarantee lets a test be written for it; only a test that uses the value
 * can fail when it changes. Both checks are static and work on text: a value counts as used when
 * a linked test writes it as a literal (see `TestCase.literals`), which says nothing about what
 * the test asserts. They are hints toward the holes a mutation tool would find, not proof.
 */
export interface DecisionRuleInput {
  units: readonly Unit[];
  tests: readonly TestCase[];
  ignore: ReadonlySet<string>;
  /** Unit id → surface units that call it */
  callersOf: ReadonlyMap<string, readonly string[]>;
  /** Contract text a unit's decisions may be named in (its own and its callers' guarantees and examples) */
  corpusOf: (unit: Unit) => string;
  /** Whether a unit states something (has a guarantee other than a placeholder) */
  stated: (unit: Unit) => boolean;
  truncatedCollections: ReadonlyArray<{ name: string; file: string; size: number }>;
  collectionLimit: number;
  /**
   * Whether a value report confirms the decision: a test failed when its value changed (#61).
   * A confirmed decision gives neither `decision-unspecified` nor `decision-untested`.
   */
  confirmed?: (unit: Unit, decision: Decision) => boolean;
}

export type DecisionRuleId =
  | "decision-unspecified"
  | "decision-untested"
  | "test-tautology"
  | "decision-collection-truncated";

export interface DecisionDraft {
  message: string;
  file?: string;
  line?: number;
  unit?: string;
  test?: string;
  /** Lower the configured severity one step (fail → warn, warn → info). */
  downgrade?: boolean;
}

/** Tests that do not run cannot pin anything. */
function runs(t: TestCase): boolean {
  return t.status !== "todo" && t.status !== "skip";
}

const RESOLVED_MODULE = /\.(?:m|c)?tsx?$/;

/**
 * The tests linked to a unit: its own running tests plus those of every surface unit that
 * reaches it through calls (transitively). A test of `ms("1d")` exercises the `parse` it
 * delegates to.
 */
export function linkedTestsIndex(
  tests: readonly TestCase[],
  callersOf: ReadonlyMap<string, readonly string[]>,
): (unitId: string) => TestCase[] {
  const testsByUnit = new Map<string, TestCase[]>();
  for (const t of tests) {
    if (t.unitId === undefined || !runs(t)) continue;
    testsByUnit.set(t.unitId, [...(testsByUnit.get(t.unitId) ?? []), t]);
  }
  const cache = new Map<string, TestCase[]>();
  return (id) => {
    const cached = cache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    const queue = [id];
    const out: TestCase[] = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === undefined || seen.has(cur)) continue;
      seen.add(cur);
      out.push(...(testsByUnit.get(cur) ?? []));
      queue.push(...(callersOf.get(cur) ?? []));
    }
    cache.set(id, out);
    return out;
  };
}

export function evaluateDecisionRules(
  input: DecisionRuleInput,
  emit: (rule: DecisionRuleId, draft: DecisionDraft) => void,
): void {
  const linkedTests = linkedTestsIndex(input.tests, input.callersOf);
  const literalsOf = (id: string): string[] => linkedTests(id).flatMap((t) => t.literals);
  // Reports read from disk before `keys` existed have none.
  const keysOf = (id: string): string[] => linkedTests(id).flatMap((t) => t.keys ?? []);
  const lengthsOf = (id: string): number[] => linkedTests(id).flatMap((t) => t.lengths ?? []);
  const confirmed = input.confirmed ?? (() => false);
  const ignored = (d: Decision): boolean =>
    d.values.some((v) => input.ignore.has(v)) || d.names.some((n) => input.ignore.has(n));

  // An element of a collection may be reached from several units (`[...SHARED, "x"]`); a test of
  // any of them that uses it pins it. Only units with a `member` decision on the collection count,
  // so an unrelated test that happens to hold the same string does not.
  const memberKey = (d: Decision): string =>
    `${d.collection?.file ?? ""}#${d.collection?.name ?? ""}|${d.values[0] ?? ""}`;
  const memberUsedBy = new Map<string, string[]>();
  for (const unit of input.units) {
    for (const d of unit.decisions) {
      if (d.kind !== "member") continue;
      const key = memberKey(d);
      const by = memberUsedBy.get(key) ?? [];
      if (!by.includes(unit.id) && valueUsed(d, literalsOf(unit.id), keysOf(unit.id))) by.push(unit.id);
      memberUsedBy.set(key, by);
    }
  }
  // A linked test that builds its input with another function of the unit's own module gets the
  // value from the implementation's side: both change together, and the test stays green (#47).
  const builtBy = (unit: Unit, d: Decision): { test: string; name: string; reads?: true } | undefined => {
    // A test that reads the decision's own constant from the unit's module (#57).
    for (const t of linkedTests(unit.id))
      for (const r of t.reads ?? [])
        if (r.from === unit.file && d.names.includes(r.name)) return { test: t.key, name: r.name, reads: true };
    for (const t of linkedTests(unit.id))
      for (const b of t.builds ?? [])
        if (b.from === unit.file && b.name !== unit.operation && b.name !== unit.target && valueUsed(d, b.literals))
          return { test: t.key, name: b.name };
    return undefined;
  };
  const memberUsed = (d: Decision): boolean => (memberUsedBy.get(memberKey(d)) ?? []).length > 0;

  // decision-untested on a member is reported once, preferably on a unit in the collection's module.
  const untestedMembers = new Map<string, { unit: Unit; decision: Decision }>();

  for (const unit of input.units) {
    // Only once the unit states something: a unit without guarantees is already reported.
    if (!input.stated(unit)) continue;
    const corpus = input.corpusOf(unit);
    const hasLinkedTests = linkedTests(unit.id).length > 0;
    const literals = literalsOf(unit.id);
    const keys = keysOf(unit.id);
    const lengths = lengthsOf(unit.id);
    const ownLiterals = input.tests.filter((t) => t.unitId === unit.id && runs(t)).flatMap((t) => t.literals);
    // Unnamed members are reported per collection, not per element.
    const unnamedMembers = new Map<string, { decisions: Decision[]; allUsed: boolean }>();
    for (const d of unit.decisions) {
      if (ignored(d) || confirmed(unit, d)) continue;
      const used =
        d.kind === "member" ? memberUsed(d) : valueUsed(d, literals, keys, lengths) || quantityUnitUsed(d, ownLiterals);
      if (!decisionMentioned(d, corpus, input.ignore)) {
        if (d.kind === "member") {
          const key = d.names[0] ?? d.collection?.name ?? "";
          const group = unnamedMembers.get(key) ?? { decisions: [], allUsed: true };
          group.decisions.push(d);
          group.allUsed &&= used;
          unnamedMembers.set(key, group);
          continue;
        }
        const named = d.names.length > 0 ? ` (${d.names.join(", ")})` : "";
        emit("decision-unspecified", {
          message: `${unit.id} commits to ${d.kind} ${d.values.map((v) => JSON.stringify(v)).join(", ")}${named} in \`${d.expression}\`, but no guarantee or example names it; a test written from the contract cannot tell whether it is right${used ? " (a linked test uses it)" : ""}`,
          file: unit.file,
          line: d.line,
          unit: unit.id,
          ...(used ? { downgrade: true } : {}),
        });
        continue;
      }
      if (!hasLinkedTests) continue;
      if (d.kind === "member") {
        // Pinned by this unit's own linked tests: nothing to say. Pinned only by another unit's
        // tests: still reported (this unit's contract is weaker than it looks), one step lower.
        if (valueUsed(d, literals, keys)) continue;
        const key = memberKey(d);
        const current = untestedMembers.get(key);
        const home = d.collection?.file === unit.file;
        if (!current || (home && current.decision.collection?.file !== current.unit.file))
          untestedMembers.set(key, { unit, decision: d });
        continue;
      }
      if (used) continue;
      emit("decision-untested", {
        message: untestedMessage(unit, d, literals, [], builtBy(unit, d)),
        file: unit.file,
        line: d.line,
        unit: unit.id,
      });
    }
    for (const [name, group] of unnamedMembers) {
      const first = group.decisions[0];
      if (!first) continue;
      const shown = group.decisions.slice(0, 3).map((d) => JSON.stringify(d.values[0] ?? ""));
      const more = group.decisions.length > 3 ? `, … (${group.decisions.length} in all)` : "";
      emit("decision-unspecified", {
        message: `${unit.id} commits to the members of ${name} (${shown.join(", ")}${more}) in \`${first.expression}\`, but no guarantee or example names ${name} or its members; a test written from the contract cannot tell whether the list is right${group.allUsed ? " (a linked test uses them)" : ""}`,
        file: unit.file,
        line: first.line,
        unit: unit.id,
        ...(group.allUsed ? { downgrade: true } : {}),
      });
    }
  }
  for (const { unit, decision } of untestedMembers.values()) {
    const others = (memberUsedBy.get(memberKey(decision)) ?? []).filter((id) => id !== unit.id);
    emit("decision-untested", {
      message: untestedMessage(unit, decision, literalsOf(unit.id), others, builtBy(unit, decision)),
      file: unit.file,
      line: decision.line,
      unit: unit.id,
      ...(others.length > 0 ? { downgrade: true } : {}),
    });
  }

  // test-tautology: a test of the unit (or of a caller) that derives its cases from the very
  // collection the unit checks membership in. A test linked elsewhere that walks the collection
  // checks a property of the list itself ("every element exists in the route table") and is fine.
  const reported = new Set<string>();
  for (const unit of input.units) {
    const files = new Map<string, Set<string>>();
    for (const d of unit.decisions) {
      if (d.kind !== "member") continue;
      for (const name of d.names) {
        const set = files.get(name) ?? new Set<string>();
        if (d.collection?.name === name) set.add(d.collection.file);
        files.set(name, set);
      }
    }
    if (files.size === 0) continue;
    for (const t of linkedTests(unit.id)) {
      for (const iterated of t.iterates) {
        const declared = files.get(iterated.name);
        if (!declared) continue;
        // A resolved module must be the one declaring the collection; an aliased specifier is matched by name.
        if (RESOLVED_MODULE.test(iterated.from) && declared.size > 0 && !declared.has(iterated.from)) continue;
        const key = `${t.file}:${t.line}|${iterated.name}`;
        if (reported.has(key)) continue;
        reported.add(key);
        emit("test-tautology", {
          message: `${t.key} takes its cases from ${iterated.name} itself; it passes whatever ${iterated.name} holds, so removing an element cannot fail it. List the elements it should hold as literals`,
          file: t.file,
          line: t.line,
          test: t.key,
          unit: unit.id,
        });
      }
    }
  }

  for (const c of input.truncatedCollections)
    emit("decision-collection-truncated", {
      message: `${c.name} holds ${c.size} elements; only the first ${input.collectionLimit} are checked as member decisions (decisions.collectionLimit)`,
      file: c.file,
    });
}

export function untestedMessage(
  unit: Unit,
  d: Decision,
  literals: readonly string[],
  pinnedBy: readonly string[] = [],
  built?: { test: string; name: string; reads?: true },
): string {
  const named = d.names.length > 0 ? ` (${d.names.join(", ")})` : "";
  const head = `${unit.id} commits to ${d.kind} ${d.values.map((v) => JSON.stringify(v)).join(", ")}${named} and the contract names it`;
  if (built)
    return `${head}, but no linked test writes it; ${built.test} ${built.reads ? "reads" : "builds its input with"} ${built.name} from the unit's own module, so the value changes with the implementation. Write it as a literal`;
  const what = `${head}, but no linked test uses it`;
  if (pinnedBy.length > 0)
    return `${what} (a test of ${pinnedBy.join(", ")} uses it); ${unit.id}'s own tests cannot fail when it changes`;
  const near = closestLiteral(d, literals);
  const closest = near !== undefined ? ` (closest: ${JSON.stringify(near)})` : "";
  return `${what}${closest}; a test cannot fail when it changes`;
}

const CLOSEST_LENGTH = 60;

/**
 * The linked-test literal a reader should look at, for triage. Candidates are ranked, and the
 * shortest of the best rank wins: (1) a literal holding a `key=` pair for the decision's key, (2) a
 * literal holding the value as a whole token (bounded by the ends, whitespace or `= & ? ; / , :`;
 * `-` and `_` are part of a word), (3) any literal containing the value. For values of one or two
 * characters, rank 3 is skipped: almost every literal contains them, and a wrong hint costs more
 * than none.
 */
function closestLiteral(d: Decision, literals: readonly string[]): string | undefined {
  const rankOf = (l: string): number | undefined => {
    if (d.key !== undefined && keyPair(d.key).test(l)) return 1;
    if (d.values.some((v) => l !== v && wholeToken(v).test(l))) return 2;
    if (d.values.some((v) => v.length > 2 && l !== v && l.includes(v))) return 3;
    return undefined;
  };
  let best: { literal: string; rank: number } | undefined;
  for (const l of literals) {
    const rank = rankOf(l);
    if (rank === undefined) continue;
    if (!best || rank < best.rank || (rank === best.rank && l.length < best.literal.length))
      best = { literal: l, rank };
  }
  if (!best) return undefined;
  const text = best.literal;
  return text.length > CLOSEST_LENGTH ? `${text.slice(0, CLOSEST_LENGTH - 1)}…` : text;
}

const TOKEN_BOUNDARY = "\\s=&?;/,:";

function wholeToken(value: string): RegExp {
  return new RegExp(`(?:^|[${TOKEN_BOUNDARY}])${escapeRegExp(value)}(?:$|[${TOKEN_BOUNDARY}])`);
}

/**
 * Whether a `match` value is the unit of a quantity one of `literals` writes in full: `case
 * "years":` and `"10 years"`, `case "d":` and `"2d"`. `"1 year"` does not hold `"years"`, and a
 * sentence (`"1 week ago"`) is not a quantity (#66).
 *
 * Only the unit's own linked tests count, not its callers'. A caller's test may write the same
 * quantity as an expected output (`format(…)` gives `"1 hour"`), which does not exercise the
 * unit's match.
 */
export function quantityUnitUsed(d: Decision, ownLiterals: readonly string[]): boolean {
  if (d.kind !== "match") return false;
  return d.values.some((v) => {
    if (!/[A-Za-z]/.test(v)) return false;
    const quantity = new RegExp(`^\\s*-?\\d*\\.?\\d+\\s*${escapeRegExp(v)}\\s*$`);
    return ownLiterals.some((l) => quantity.test(l));
  });
}

function keyPair(key: string): RegExp {
  return new RegExp(`(?:^|[?&;])${escapeRegExp(key)}=`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * `key=value` as one pair of a query or cookie string: bounded by the start or `?` / `&` / `;`
 * before, and by the end or `&` / `;` / `#` after. A bare substring would let `"1"` match
 * almost any literal.
 */
function keyValuePair(key: string, value: string): RegExp {
  return new RegExp(`(?:^|[?&;])${escapeRegExp(key)}=${escapeRegExp(value)}(?:$|[&;#])`);
}

function isNumberText(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value)) && /^-?[\d.e+]+$/i.test(value);
}

/**
 * Whether one of the test literals uses a decision's value: numbers by value (a boundary also
 * by value ± 1, the sides a test probes), an `output` inside a larger expected string, a
 * `member` by the collection's probe (a prefix list is pinned by a longer path that starts
 * with the element), anything else by equality. A `match` on a value read with a key is also
 * used by a `key=value` pair in a literal (`"?popup=1"`), and an identifier-like `match` value
 * by an object key the test writes (`{ iss: … }`, see `TestCase.keys`).
 */
export function valueUsed(
  d: Decision,
  literals: readonly string[],
  keys: readonly string[] = [],
  lengths: readonly number[] = [],
): boolean {
  return d.values.some((v) => {
    // A limit on a count is tested with arrays of that size, not by writing the number (#56).
    if (d.length && isNumberText(v)) {
      const n = Number(v);
      if (lengths.some((m) => m === n || (d.kind === "boundary" && Math.abs(m - n) === 1))) return true;
    }
    if (d.kind === "match") {
      if (d.key !== undefined && literals.some((l) => keyValuePair(d.key ?? "", v).test(l))) return true;
      if (IDENTIFIER.test(v) && keys.includes(v)) return true;
    }
    if (isNumberText(v)) {
      const n = Number(v);
      return literals.some((l) => {
        if (!isNumberText(l)) return false;
        const m = Number(l);
        return m === n || (d.kind === "boundary" && Math.abs(m - n) === 1);
      });
    }
    if (d.kind === "output") return literals.some((l) => l.includes(v));
    if (d.kind === "member") {
      if (d.key !== undefined && literals.some((l) => keyValuePair(d.key ?? "", v).test(l))) return true;
      // Keys are whole names, so they pin an exact member only (`{ default: … }` pins "default").
      if ((d.probe ?? "exact") === "exact" && IDENTIFIER.test(v) && keys.includes(v)) return true;
      switch (d.probe) {
        case "prefix":
          return literals.some((l) => l.startsWith(v));
        case "suffix":
          return literals.some((l) => l.endsWith(v));
        case "contains":
          return literals.some((l) => l.includes(v));
        default:
          return literals.includes(v);
      }
    }
    return literals.includes(v);
  });
}
