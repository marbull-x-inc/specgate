import type { TestCase, Unit } from "../ir/schema.ts";
import type { MappedMutant, MutantPlace } from "../mutation/report.ts";

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
  /** Mutants mapped to units, or why the report (or, per path, each report) could not be read */
  result:
    | { mapped: readonly MappedMutant[] }
    | { error: string }
    | { errors: ReadonlyArray<{ path: string; error: string }> };
  linkedTests: (unitId: string) => readonly TestCase[];
  /** `mutation.findings`: one `mutant-survived` per mutant (default) or one per unit */
  findings?: "mutant" | "unit";
  /** `mutation.listLimit`: survivors listed in a per-unit finding */
  listLimit?: number;
  /** `mutation.exclude`: units whose mutants are counted but give no findings */
  excluded?: (unit: Unit) => boolean;
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
/** `mutatorName` of the value mutants a runner applies from `specgate mutants` (#60) */
const VALUE_MUTATOR = "Value";
const DEFAULT_LIST_LIMIT = 5;

function shortened(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > REPLACEMENT_LENGTH ? `${one.slice(0, REPLACEMENT_LENGTH - 1)}…` : one;
}

/** A mutant the linked tests let through, described for the unit it is reported on. */
interface Survivor {
  mapped: MappedMutant;
  unit: Unit;
  /** `StringLiteral mutant in BLOCKED: \`""\`` */
  what: string;
  /** Other units that reach the mutant */
  others: string[];
}

function describeSurvivor(m: MappedMutant, unit: Unit, place: MutantPlace, others: string[]): Survivor {
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
      : place === "constant"
        ? undefined
        : // The unit's decisions include those of the helpers it reaches, so a helper line is found too.
          (unit.decisions.find((d) => d.line === mutant.line && d.kind !== "member") ??
          unit.decisions.find((d) => d.line === mutant.line));
  const constant =
    place === "constant"
      ? unit.constantRanges?.find((c) => c.file === mutant.file && mutant.line >= c.line && mutant.line <= c.endLine)
      : undefined;
  const where =
    place === "helper"
      ? " in a helper it calls"
      : place === "collection" && decision?.collection
        ? ` in ${decision.collection.name}`
        : constant
          ? ` in ${constant.name}`
          : "";
  // On the probe line of a membership test, the mutant changes the test, not one element.
  const about =
    !decision || place === "collection"
      ? ""
      : decision.kind === "member"
        ? ` (membership in ${decision.collection?.name ?? decision.names[0] ?? "a collection"})`
        : ` (the ${decision.kind} ${decision.values.map((v) => JSON.stringify(v)).join(", ")})`;
  // A value mutant (#60) names its change in contract terms: "the default `initialValue` 0 → 1".
  if (mutant.mutator === VALUE_MUTATOR && mutant.description !== undefined)
    return { mapped: m, unit, what: mutant.description, others };
  const replaced = mutant.replacement !== undefined ? `: \`${shortened(mutant.replacement)}\`` : "";
  return { mapped: m, unit, what: `${mutant.mutator} mutant${where}${about}${replaced}`, others };
}

export function evaluateMutationRules(
  input: MutationRuleInput,
  emit: (rule: MutationRuleId, draft: MutationDraft) => void,
): void {
  if ("error" in input.result || "errors" in input.result) {
    const errors = "error" in input.result ? [{ path: input.path, error: input.result.error }] : input.result.errors;
    for (const e of errors)
      emit("mutation-report-unreadable", {
        message: `mutation.report ${e.path}: ${e.error}; the mutation rules did not run`,
        file: e.path,
      });
    return;
  }
  const mapped = input.result.mapped;
  const excluded = input.excluded ?? (() => false);

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
    if (excluded(unit)) continue;
    emit("unit-not-executed", {
      message: `${unit.id} has ${tests.length} linked test(s), but none of them runs its code: all ${counted.length} mutant(s) in it are NoCoverage. The tests may replace it with a stub or call another implementation`,
      file: unit.file,
      line: unit.line,
      unit: unit.id,
    });
  }

  // The mutants the tests let through, each on the first unit it belongs to that is not excluded.
  const survivors: Survivor[] = [];
  for (const m of mapped) {
    if (m.outcome !== "survived" && m.outcome !== "noCoverage") continue;
    const reaching = m.units.filter((u) => !excluded(u.unit));
    const first = reaching[0];
    if (!first) continue;
    const { unit, place } = first;
    // An unexecuted unit is reported once, and a unit with no linked test is not expected to be run.
    if (m.outcome === "noCoverage" && (notExecuted.has(unit) || input.linkedTests(unit.id).length === 0)) continue;
    const others = [...new Set(reaching.slice(1).map((u) => u.unit.id))];
    survivors.push(describeSurvivor(m, unit, place, others));
  }

  if (input.findings === "unit") {
    emitPerUnit(survivors, input.listLimit ?? DEFAULT_LIST_LIMIT, emit);
    return;
  }
  for (const s of survivors) {
    const mutant = s.mapped.mutant;
    const also = s.others.length > 0 ? `; also reached from ${s.others.join(", ")}` : "";
    const outcome =
      s.mapped.outcome === "survived"
        ? "survived; no linked test fails when the code changes like this"
        : "is not run by any test";
    emit("mutant-survived", {
      message: `${s.unit.id}: ${s.what} ${outcome}${also}`,
      file: mutant.file,
      line: mutant.line,
      unit: s.unit.id,
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

/** `mutation.findings: "unit"`: one `mutant-survived` per unit, listing its first survivors by line. */
function emitPerUnit(
  survivors: readonly Survivor[],
  listLimit: number,
  emit: (rule: MutationRuleId, draft: MutationDraft) => void,
): void {
  const byUnit = new Map<Unit, Survivor[]>();
  for (const s of survivors) byUnit.set(s.unit, [...(byUnit.get(s.unit) ?? []), s]);
  for (const [unit, list] of byUnit) {
    const sorted = [...list].sort((a, b) => a.mapped.mutant.line - b.mapped.mutant.line);
    const survived = sorted.filter((s) => s.mapped.outcome === "survived").length;
    const notRun = sorted.length - survived;
    const counts = [
      ...(survived > 0 ? [`${survived} survived`] : []),
      ...(notRun > 0 ? [`${notRun} not run by any test`] : []),
    ].join(", ");
    const shown = sorted
      .slice(0, Math.max(0, listLimit))
      .map((s) => `line ${s.mapped.mutant.line} ${s.what}${s.mapped.outcome === "noCoverage" ? " (not run)" : ""}`);
    const more = sorted.length > shown.length ? `; and ${sorted.length - shown.length} more` : "";
    const first = sorted[0];
    emit("mutant-survived", {
      message: `${unit.id}: ${sorted.length} mutant(s) the linked tests let through (${counts})${shown.length > 0 ? `: ${shown.join("; ")}` : ""}${more}`,
      ...(first ? { file: first.mapped.mutant.file, line: first.mapped.mutant.line } : { file: unit.file }),
      unit: unit.id,
    });
  }
}
