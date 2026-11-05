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
  /** The report's `description`; a value mutant (#60) names its change in contract terms there */
  description?: string;
  status: string;
  /** Module relative to root, POSIX separators */
  file: string;
  line: number;
  endLine: number;
}

export type MutationReadResult = { mutants: Mutant[] } | { error: string };

/** `mutation.report` as a list of paths (one string is a list of one). */
export function reportPaths(config: Config): string[] {
  const r = config.mutation.report;
  return r === undefined ? [] : typeof r === "string" ? [r] : r;
}

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
      const description = m["description"];
      mutants.push({
        id: String(id),
        mutator,
        ...(typeof replacement === "string" ? { replacement } : {}),
        ...(typeof description === "string" && description !== "" ? { description } : {}),
        status,
        file,
        line: start,
        endLine: Math.max(start, end ?? start),
      });
    }
  }
  return { mutants };
}

/** The mutants of every report in `mutation.report`, or, per path that could not be used, why. */
export type MutationReadAll = { mutants: Mutant[] } | { errors: Array<{ path: string; error: string }> };

/**
 * Reads every path of `mutation.report` (Stryker's report and a value-mutant report, #60).
 * Mutant ids are prefixed with the report's index when there are several, so they stay unique.
 * @returns `undefined` when no report is configured; the mutants of all reports; or, when any
 *   report could not be used, why for each such path. Never throws.
 */
export function readMutationReports(config: Config): MutationReadAll | undefined {
  const paths = reportPaths(config);
  if (paths.length === 0) return undefined;
  const mutants: Mutant[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  paths.forEach((path, index) => {
    const result = readOneReport(config, path);
    if ("error" in result) errors.push({ path, error: result.error });
    else mutants.push(...result.mutants.map((m) => (paths.length > 1 ? { ...m, id: `${index + 1}:${m.id}` } : m)));
  });
  return errors.length > 0 ? { errors } : { mutants };
}

/**
 * Reads the first path of `mutation.report`.
 * @returns `undefined` when no report is configured; otherwise the mutants or why the file
 *   could not be used (missing, not JSON, not a report). Never throws.
 */
export function readMutationReport(config: Config): MutationReadResult | undefined {
  const path = reportPaths(config)[0];
  return path === undefined ? undefined : readOneReport(config, path);
}

function readOneReport(config: Config, relativePath: string): MutationReadResult {
  const path = resolve(config.root, relativePath);
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
export type MutantPlace = "body" | "helper" | "collection" | "constant";

export interface MappedMutant {
  mutant: Mutant;
  outcome: MutantOutcome;
  /** Every unit the mutant belongs to, the unit a finding is reported on first */
  units: Array<{ unit: Unit; place: MutantPlace }>;
}

const PLACE_ORDER: Record<MutantPlace, number> = { body: 0, helper: 1, collection: 2, constant: 3 };

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
  const constantUsers = new Map<string, Array<{ unit: Unit; line: number; endLine: number }>>();
  for (const u of units) {
    for (const c of u.constantRanges ?? [])
      constantUsers.set(c.file, [...(constantUsers.get(c.file) ?? []), { unit: u, line: c.line, endLine: c.endLine }]);
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
    for (const c of constantUsers.get(m.file) ?? [])
      if (!places.has(c.unit) && within(c)) places.set(c.unit, "constant");
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
