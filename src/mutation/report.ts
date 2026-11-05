import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "../config/schema.ts";
import type { MutationCounts, Unit } from "../ir/schema.ts";
import { fileExists, relativeTo } from "../util/paths.ts";

/**
 * Reading a mutation report that another tool produced (phase 2 of
 * docs/design/0002-decisions-pinned-by-tests.md; see docs/design/0003-mutation-report.md).
 *
 * @remarks
 * specgate never runs tests or mutants. It reads a JSON report in the
 * mutation-testing-report-schema (versions 1–3, the format of Stryker's `mutation.json`) and
 * maps each mutant to the units whose code it changed. Validation is hand-written, like the
 * config's, so the published package keeps no schema library at run time.
 */
export interface Mutant {
  id: string;
  mutator: string;
  replacement?: string;
  status: string;
  /** Module relative to root, POSIX separators */
  file: string;
  line: number;
  endLine: number;
}

export type MutationReadResult = { mutants: Mutant[] } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function position(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const line = value["line"];
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined;
}

/**
 * Parses a mutation report. Paths in `files` are resolved against the report's `projectRoot`
 * when it gives one, otherwise against `root`.
 * @returns The mutants, or the reason the value is not a report.
 */
export function parseMutationReport(value: unknown, root: string): MutationReadResult {
  if (!isRecord(value)) return { error: "not a JSON object" };
  const files = value["files"];
  if (!isRecord(files)) return { error: "no `files` object (not a mutation-testing-report-schema report)" };
  const projectRoot = typeof value["projectRoot"] === "string" ? resolve(root, value["projectRoot"]) : root;
  const mutants: Mutant[] = [];
  for (const [path, entry] of Object.entries(files)) {
    if (!isRecord(entry) || !Array.isArray(entry["mutants"])) return { error: `files["${path}"] has no mutants array` };
    const file = relativeTo(root, isAbsolute(path) ? path : resolve(projectRoot, path));
    for (const [index, m] of entry["mutants"].entries()) {
      const at = `files["${path}"].mutants[${index}]`;
      if (!isRecord(m)) return { error: `${at} is not an object` };
      const id = m["id"];
      const mutator = m["mutatorName"];
      const status = m["status"];
      const location = m["location"];
      const start = isRecord(location) ? position(location["start"]) : undefined;
      const end = isRecord(location) ? position(location["end"]) : undefined;
      if (typeof id !== "string" && typeof id !== "number") return { error: `${at}.id is missing` };
      if (typeof mutator !== "string") return { error: `${at}.mutatorName is missing` };
      if (typeof status !== "string") return { error: `${at}.status is missing` };
      if (start === undefined) return { error: `${at}.location.start.line is missing` };
      const replacement = m["replacement"];
      mutants.push({
        id: String(id),
        mutator,
        ...(typeof replacement === "string" ? { replacement } : {}),
        status,
        file,
        line: start,
        endLine: Math.max(start, end ?? start),
      });
    }
  }
  return { mutants };
}

/**
 * Reads `mutation.report`.
 * @returns `undefined` when no report is configured; otherwise the mutants or why the file
 *   could not be used (missing, not JSON, not a report). Never throws.
 */
export function readMutationReport(config: Config): MutationReadResult | undefined {
  if (config.mutation.report === undefined) return undefined;
  const path = resolve(config.root, config.mutation.report);
  if (!fileExists(path)) return { error: "file not found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { error: `not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  return parseMutationReport(parsed, resolve(config.root));
}

/** How a mutant's status counts for a unit. */
export type MutantOutcome = keyof MutationCounts;

export function outcomeOf(status: string, detected: readonly string[]): MutantOutcome {
  if (detected.includes(status)) return "killed";
  if (status === "Survived") return "survived";
  if (status === "NoCoverage") return "noCoverage";
  return "ignored";
}

/**
 * Where a mutant belongs: `body` (the unit's own lines), `helper` (a helper the unit reaches,
 * `Unit.helperRanges`) or `collection` (the declaration of a collection the unit has `member`
 * decisions on).
 */
export type MutantPlace = "body" | "helper" | "collection";

export interface MappedMutant {
  mutant: Mutant;
  outcome: MutantOutcome;
  /** Every unit the mutant belongs to, the unit a finding is reported on first */
  units: Array<{ unit: Unit; place: MutantPlace }>;
}

const PLACE_ORDER: Record<MutantPlace, number> = { body: 0, helper: 1, collection: 2 };

/**
 * Maps mutants to units by file and line. In a unit's own lines, the innermost unit wins (a
 * function declared inside another unit's range). A mutant in a shared helper or collection
 * belongs to every unit that reaches it. Mutants outside every unit are dropped.
 */
export function mapMutants(
  units: readonly Unit[],
  mutants: readonly Mutant[],
  detected: readonly string[],
): MappedMutant[] {
  const byFile = new Map<string, Unit[]>();
  const collectionUsers = new Map<string, Array<{ unit: Unit; line: number; endLine: number }>>();
  for (const u of units) {
    if (u.kind === "function" || u.kind === "method") byFile.set(u.file, [...(byFile.get(u.file) ?? []), u]);
    const seen = new Set<string>();
    for (const d of u.decisions) {
      const c = d.collection;
      if (d.kind !== "member" || !c) continue;
      const key = `${c.file}#${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collectionUsers.set(c.file, [
        ...(collectionUsers.get(c.file) ?? []),
        { unit: u, line: c.line, endLine: c.endLine },
      ]);
    }
  }
  const out: MappedMutant[] = [];
  for (const m of mutants) {
    const within = (r: { line: number; endLine: number }): boolean => m.line >= r.line && m.endLine <= r.endLine;
    const places = new Map<Unit, MutantPlace>();
    const own = (byFile.get(m.file) ?? []).filter(within);
    const innermost = own.sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
    if (innermost) places.set(innermost, "body");
    for (const u of byFile.get(m.file) ?? [])
      if (!places.has(u) && (u.helperRanges ?? []).some(within)) places.set(u, "helper");
    for (const c of collectionUsers.get(m.file) ?? [])
      if (!places.has(c.unit) && within(c)) places.set(c.unit, "collection");
    if (places.size === 0) continue;
    out.push({
      mutant: m,
      outcome: outcomeOf(m.status, detected),
      units: [...places]
        .map(([unit, place]) => ({ unit, place }))
        .sort(
          (a, b) =>
            PLACE_ORDER[a.place] - PLACE_ORDER[b.place] ||
            Number(b.unit.file === m.file) - Number(a.unit.file === m.file) ||
            a.unit.id.localeCompare(b.unit.id),
        ),
    });
  }
  return out.sort((a, b) => a.mutant.file.localeCompare(b.mutant.file) || a.mutant.line - b.mutant.line);
}

/**
 * Share of the counted mutants the tests caught, as a whole percentage: killed over killed,
 * survived and no coverage (ignored ones are left out). `undefined` when nothing was counted.
 */
export function mutationScore(c: MutationCounts): number | undefined {
  const counted = c.killed + c.survived + c.noCoverage;
  return counted === 0 ? undefined : Math.floor((c.killed / counted) * 100);
}

/** Per-unit counts of the mapped mutants (every unit a mutant belongs to counts it). */
export function countMutants(mapped: readonly MappedMutant[]): Map<Unit, MutationCounts> {
  const counts = new Map<Unit, MutationCounts>();
  for (const m of mapped)
    for (const { unit } of m.units) {
      const c = counts.get(unit) ?? { killed: 0, survived: 0, noCoverage: 0, ignored: 0 };
      c[m.outcome] += 1;
      counts.set(unit, c);
    }
  return counts;
}
