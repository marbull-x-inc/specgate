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
  const ignored = (d: Decision): boolean =>
    d.values.some((v) => input.ignore.has(v)) || d.names.some((n) => input.ignore.has(n));

  // An element of a collection may be reached from several units (`[...SHARED, "x"]`); a test of
  // any of them that uses it pins it.
  const memberKey = (d: Decision): string =>
    `${d.collection?.file ?? ""}#${d.collection?.name ?? ""}|${d.values[0] ?? ""}`;
  const memberUsed = new Map<string, boolean>();
  for (const unit of input.units) {
    for (const d of unit.decisions) {
      if (d.kind !== "member") continue;
      const key = memberKey(d);
      if (memberUsed.get(key) !== true) memberUsed.set(key, valueUsed(d, literalsOf(unit.id)));
    }
  }

  // decision-untested on a member is reported once, preferably on a unit in the collection's module.
  const untestedMembers = new Map<string, { unit: Unit; decision: Decision }>();

  for (const unit of input.units) {
    // Only once the unit states something: a unit without guarantees is already reported.
    if (!input.stated(unit)) continue;
    const corpus = input.corpusOf(unit);
    const hasLinkedTests = linkedTests(unit.id).length > 0;
    const literals = literalsOf(unit.id);
    // Unnamed members are reported per collection, not per element.
    const unnamedMembers = new Map<string, { decisions: Decision[]; allUsed: boolean }>();
    for (const d of unit.decisions) {
      if (ignored(d)) continue;
      const used = d.kind === "member" ? memberUsed.get(memberKey(d)) === true : valueUsed(d, literals);
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
      if (!hasLinkedTests || used) continue;
      if (d.kind === "member") {
        const key = memberKey(d);
        const current = untestedMembers.get(key);
        const home = d.collection?.file === unit.file;
        if (!current || (home && current.decision.collection?.file !== current.unit.file))
          untestedMembers.set(key, { unit, decision: d });
        continue;
      }
      emit("decision-untested", {
        message: untestedMessage(unit, d),
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
  for (const { unit, decision } of untestedMembers.values())
    emit("decision-untested", {
      message: untestedMessage(unit, decision),
      file: unit.file,
      line: decision.line,
      unit: unit.id,
    });

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

function untestedMessage(unit: Unit, d: Decision): string {
  const named = d.names.length > 0 ? ` (${d.names.join(", ")})` : "";
  return `${unit.id} commits to ${d.kind} ${d.values.map((v) => JSON.stringify(v)).join(", ")}${named} and the contract names it, but no linked test uses it; a test cannot fail when it changes`;
}

function isNumberText(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value)) && /^-?[\d.e+]+$/i.test(value);
}

/**
 * Whether one of the test literals uses a decision's value: numbers by value (a boundary also
 * by value ± 1, the sides a test probes), an `output` inside a larger expected string, a
 * `member` by the collection's probe (a prefix list is pinned by a longer path that starts
 * with the element), anything else by equality.
 */
export function valueUsed(d: Decision, literals: readonly string[]): boolean {
  return d.values.some((v) => {
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
