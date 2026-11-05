import type { TestCase, Unit } from "../ir/schema.ts";
import type { MappedMutant } from "../mutation/report.ts";

/**
 * Rules over a mutation report: which mutants the linked tests let through, and which units
 * the tests never run.
 *
 * @remarks
 * A surviving mutant is a change to the implementation that no test fails on. The static
 * decision rules guess at these from literals; a mutation report knows. It also sees what is
 * not a value: a flipped condition, a removed call, a reordered route.
 */
export interface MutationRuleInput {
  /** `mutation.report` as configured */
  path: string;
  /** Mutants mapped to units, or why the report could not be read */
  result: { mapped: readonly MappedMutant[] } | { error: string };
  linkedTests: (unitId: string) => readonly TestCase[];
}

export type MutationRuleId = "mutant-survived" | "unit-not-executed" | "mutation-report-unreadable";

export interface MutationDraft {
  message: string;
  file?: string;
  line?: number;
  unit?: string;
  mutant?: { id: string; mutator: string; replacement?: string; status: string; line: number };
}

const REPLACEMENT_LENGTH = 60;

function shortened(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > REPLACEMENT_LENGTH ? `${one.slice(0, REPLACEMENT_LENGTH - 1)}…` : one;
}

export function evaluateMutationRules(
  input: MutationRuleInput,
  emit: (rule: MutationRuleId, draft: MutationDraft) => void,
): void {
  if ("error" in input.result) {
    emit("mutation-report-unreadable", {
      message: `mutation.report ${input.path}: ${input.result.error}; the mutation rules did not run`,
      file: input.path,
    });
    return;
  }
  const mapped = input.result.mapped;

  // unit-not-executed: a unit with linked tests whose own lines no test ran.
  const bodyOutcomes = new Map<Unit, string[]>();
  for (const m of mapped)
    for (const { unit, place } of m.units)
      if (place === "body") bodyOutcomes.set(unit, [...(bodyOutcomes.get(unit) ?? []), m.outcome]);
  const notExecuted = new Set<Unit>();
  for (const [unit, outcomes] of bodyOutcomes) {
    const counted = outcomes.filter((o) => o !== "ignored");
    if (counted.length === 0 || !counted.every((o) => o === "noCoverage")) continue;
    const tests = input.linkedTests(unit.id);
    if (tests.length === 0) continue;
    notExecuted.add(unit);
    emit("unit-not-executed", {
      message: `${unit.id} has ${tests.length} linked test(s), but none of them runs its code: all ${counted.length} mutant(s) in it are NoCoverage. The tests may replace it with a stub or call another implementation`,
      file: unit.file,
      line: unit.line,
      unit: unit.id,
    });
  }

  // mutant-survived: one finding per mutant the tests let through, on the unit it belongs to first.
  for (const m of mapped) {
    if (m.outcome !== "survived" && m.outcome !== "noCoverage") continue;
    const first = m.units[0];
    if (!first) continue;
    const { unit, place } = first;
    // An unexecuted unit is reported once, and a unit with no linked test is not expected to be run.
    if (m.outcome === "noCoverage" && (notExecuted.has(unit) || input.linkedTests(unit.id).length === 0)) continue;
    const mutant = m.mutant;
    const decision =
      place === "collection"
        ? unit.decisions.find(
            (d) =>
              d.kind === "member" &&
              d.collection?.file === mutant.file &&
              mutant.line >= d.collection.line &&
              mutant.line <= d.collection.endLine,
          )
        : place === "body"
          ? (unit.decisions.find((d) => d.line === mutant.line && d.kind !== "member") ??
            unit.decisions.find((d) => d.line === mutant.line))
          : undefined;
    const where =
      place === "helper"
        ? " in a helper it calls"
        : place === "collection" && decision?.collection
          ? ` in ${decision.collection.name}`
          : "";
    // On the probe line of a membership test, the mutant changes the test, not one element.
    const about =
      !decision || place === "collection"
        ? ""
        : decision.kind === "member"
          ? ` (membership in ${decision.collection?.name ?? decision.names[0] ?? "a collection"})`
          : ` (the ${decision.kind} ${decision.values.map((v) => JSON.stringify(v)).join(", ")})`;
    const replaced = mutant.replacement !== undefined ? `: \`${shortened(mutant.replacement)}\`` : "";
    const others = m.units.slice(1).map((u) => u.unit.id);
    const also = others.length > 0 ? `; also reached from ${[...new Set(others)].join(", ")}` : "";
    const outcome =
      m.outcome === "survived"
        ? "survived; no linked test fails when the code changes like this"
        : "is not run by any test";
    emit("mutant-survived", {
      message: `${unit.id}: ${mutant.mutator} mutant${where}${about}${replaced} ${outcome}${also}`,
      file: mutant.file,
      line: mutant.line,
      unit: unit.id,
      mutant: {
        id: mutant.id,
        mutator: mutant.mutator,
        ...(mutant.replacement !== undefined ? { replacement: shortened(mutant.replacement) } : {}),
        status: mutant.status,
        line: mutant.line,
      },
    });
  }
}
