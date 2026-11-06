import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyAccepted, readAccepted } from "./accepted.ts";
import type { Config } from "./config/schema.ts";
import { packageEntries } from "./extract/entries.ts";
import { createProgramHost, type ProgramHost } from "./extract/program.ts";
import { type ExtractedUnit, extractSurface } from "./extract/surface.ts";
import { extractTests } from "./extract/tests/index.ts";
import { createTsdocParser } from "./extract/tsdoc-parser.ts";
import { isReport, type Report, type Unit } from "./ir/schema.ts";
import { countMutants, mapMutants, readMutationReports, reportPaths } from "./mutation/report.ts";
import { attachProvenance } from "./provenance/git.ts";
import { readRevision } from "./provenance/revision.ts";
import { resolveReferences } from "./resolve/identifiers.ts";
import { evaluateRules } from "./rules/index.ts";
import { sha256 } from "./util/hash.ts";
import { expandGlobs, fileExists, globToRegExp } from "./util/paths.ts";

export const TOOL = { name: "specgate", version: "0.6.0" } as const;

export interface Analysis {
  report: Report;
  extracted: ExtractedUnit[];
  host: ProgramHost;
  surfaceFiles: string[];
  testFiles: string[];
}

export interface AnalyzeOptions {
  /** Skip git calls (faster, used by scaffold / gen / tests). */
  provenance?: boolean;
  /** Previous report for change detection; defaults to `<output.dir>/report.json` when present. */
  baseline?: Report | null;
  /** Apply the accepted-findings file (default true). */
  accepted?: boolean;
}

/**
 * The previous report for change detection. `chosen` is true when someone picked it (`--baseline`,
 * `output.baseline`), false for the default `<output.dir>/report.json` a previous local run left.
 */
function loadBaseline(
  config: Config,
  explicit: Report | null | undefined,
): { report: Report; chosen: boolean } | undefined {
  if (explicit === null) return undefined;
  if (explicit) return { report: explicit, chosen: true };
  const path = resolve(config.root, config.output.baseline ?? `${config.output.dir}/report.json`);
  if (!fileExists(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isReport(parsed) ? { report: parsed, chosen: config.output.baseline !== undefined } : undefined;
}

/** Hash of the resolved config without `root`, which differs between checkouts of the same code. */
function configHashOf(config: Config): string {
  const { root: _root, ...rest } = config;
  return sha256(JSON.stringify(rest)).slice(0, 16);
}

/**
 * A default baseline written on another revision or under another config: the comparison may be
 * across branches, so the change-detection findings are lowered and `baseline-stale` says why.
 */
function staleness(
  baseline: { report: Report; chosen: boolean } | undefined,
  revision: string | undefined,
  configHash: string,
): { baseline: string; current: string } | undefined {
  if (!baseline || baseline.chosen) return undefined;
  const b = baseline.report;
  if (b.revision !== undefined && revision !== undefined && b.revision !== revision)
    return { baseline: `revision ${b.revision.slice(0, 12)}`, current: `revision ${revision.slice(0, 12)}` };
  if (b.configHash !== undefined && b.configHash !== configHash)
    return { baseline: `config ${b.configHash}`, current: `config ${configHash}` };
  return undefined;
}

/**
 * Runs extraction, linking, resolution, provenance and rules, producing the IR.
 *
 * @remarks
 * Linking is by key only: a test contributes to the guarantee whose `key` equals the test's
 * `key`. Nothing is inferred from file names or proximity, so a test file may be split or
 * moved freely as long as titles keep naming guarantees.
 */
export async function analyze(config: Config, options: AnalyzeOptions = {}): Promise<Analysis> {
  const surfaceFiles = await expandGlobs(config.root, config.surface.include, config.surface.exclude);
  const testFiles = await expandGlobs(config.root, config.tests.include);
  const entries = packageEntries(config);
  const entrySources = entries.flatMap((e) => (e.source ? [e.source] : []));
  const host = createProgramHost(config.root, config.tsconfig, [...surfaceFiles, ...testFiles, ...entrySources]);
  const { parser, configMessages } = createTsdocParser(config.root);
  const surface = extractSurface(host, config, parser, surfaceFiles, testFiles, entries);
  const knownTargets = new Set(
    surface.units.flatMap((e) => [
      ...(e.unit.target ? [e.unit.target] : []),
      ...(e.unit.kind === "port" ? [e.unit.id] : []),
    ]),
  );
  const testExtraction = extractTests(config, testFiles, config.tests.adapter, knownTargets);

  const units: Unit[] = surface.units.map((u) => u.unit);
  const testsByKey = new Map<string, string[]>();
  for (const t of testExtraction.tests) {
    const list = testsByKey.get(t.key) ?? [];
    list.push(`${t.file}:${t.line}`);
    testsByKey.set(t.key, list);
  }
  const scope = {
    units,
    entities: surface.entities,
    ports: surface.ports,
    programTypeNames: host.programTypeNames(),
    externalOperation: (target: string, operation: string) => host.hasPublicMember(target, operation),
  };
  for (const unit of units) {
    for (const g of unit.guarantees) {
      g.tests = testsByKey.get(g.key) ?? [];
      g.references = g.id === config.ids.placeholder ? [] : resolveReferences(unit, g.text, scope, config);
    }
  }
  if (options.provenance !== false) attachProvenance(config, units);

  const mutationRead = readMutationReports(config);
  const mutation =
    mutationRead === undefined
      ? undefined
      : {
          path: reportPaths(config).join(", "),
          result:
            "errors" in mutationRead
              ? mutationRead
              : { mapped: mapMutants(units, mutationRead.mutants, config.mutation.detected) },
          findings: config.mutation.findings,
          listLimit: config.mutation.listLimit,
          excluded: unitMatcher(config.mutation.exclude),
        };
  if (mutation && "mapped" in mutation.result)
    for (const [unit, counts] of countMutants(mutation.result.mapped)) unit.mutation = counts;
  // A gap in the mapping is shown, not silent (#53).
  const mutantsUnmapped =
    mutationRead && "mutants" in mutationRead && mutation && "mapped" in mutation.result
      ? mutationRead.mutants.length - mutation.result.mapped.length
      : undefined;

  const docMessages = [
    ...surface.docMessages,
    ...configMessages.map((text) => ({ file: "tsdoc.json", line: 1, text })),
  ];
  const baseline = loadBaseline(config, options.baseline);
  const revision = readRevision(config.root);
  const configHash = configHashOf(config);
  const stale = staleness(baseline, revision, configHash);
  const findings = applyAccepted(
    evaluateRules({
      config,
      units,
      tests: testExtraction.tests,
      unlinked: testExtraction.unlinked,
      docMessages,
      baseline: baseline?.report,
      ...(stale ? { baselineStale: stale } : {}),
      strayGuarantees: surface.strayGuarantees,
      surfaceFileCount: surfaceFiles.length,
      unmappedEntries: entries.filter((e) => e.source === undefined).map((e) => e.subpath),
      truncatedCollections: surface.truncatedCollections,
      ...(mutation ? { mutation } : {}),
    }),
    options.accepted === false ? new Set() : readAccepted(config),
  );

  const guarantees = units.flatMap((u) => u.guarantees);
  const guaranteeKeys = new Set(guarantees.map((g) => g.key));
  const report: Report = {
    $schema: "https://raw.githubusercontent.com/marbull-x-inc/specgate/main/schema/ir.schema.json",
    version: "1",
    tool: { ...TOOL },
    generatedAt: new Date().toISOString(),
    root: config.root,
    ...(revision !== undefined ? { revision } : {}),
    configHash,
    mode: config.mode,
    units: units.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    vocabulary: { entities: surface.entities, ports: surface.ports },
    tests: testExtraction.tests,
    findings,
    summary: {
      units: units.length,
      unitsWithoutGuarantee: units.filter((u) => u.guarantees.length === 0).length,
      guarantees: guarantees.length,
      guaranteesWithoutTest: guarantees.filter((g) => g.tests.length === 0).length,
      tests: testExtraction.tests.length,
      orphanTests: testExtraction.tests.filter((t) => !guaranteeKeys.has(t.key)).length,
      unlinkedTests: testExtraction.unlinked.length,
      findings: {
        fail: findings.filter((f) => f.severity === "fail").length,
        warn: findings.filter((f) => f.severity === "warn").length,
        info: findings.filter((f) => f.severity === "info").length,
      },
      ...(mutantsUnmapped !== undefined ? { mutantsUnmapped } : {}),
    },
  };
  return { report, extracted: surface.units, host, surfaceFiles, testFiles };
}

/** Exit code policy: blocking mode fails on any `fail` finding; advisory always exits 0. */
export function exitCodeFor(report: Report, strict = false): number {
  if (report.mode === "advisory" && !strict) return 0;
  return report.summary.findings.fail > 0 ? 1 : 0;
}

/** `mutation.exclude`: an entry is a unit id, or a glob over the unit's file. */
function unitMatcher(entries: readonly string[]): (unit: Unit) => boolean {
  const ids = new Set(entries);
  const globs = entries.map(globToRegExp);
  return (unit) => ids.has(unit.id) || globs.some((g) => g.test(unit.file));
}
