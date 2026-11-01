import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config/schema.ts";
import { createProgramHost, type ProgramHost } from "./extract/program.ts";
import { type ExtractedUnit, extractSurface } from "./extract/surface.ts";
import { extractTests } from "./extract/tests/index.ts";
import { createTsdocParser } from "./extract/tsdoc-parser.ts";
import { isReport, type Report, type Unit } from "./ir/schema.ts";
import { attachProvenance } from "./provenance/git.ts";
import { resolveReferences } from "./resolve/identifiers.ts";
import { evaluateRules } from "./rules/index.ts";
import { expandGlobs, fileExists } from "./util/paths.ts";

export const TOOL = { name: "specgate", version: "0.2.0" } as const;

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
}

function loadBaseline(config: Config, explicit: Report | null | undefined): Report | undefined {
  if (explicit === null) return undefined;
  if (explicit) return explicit;
  const path = resolve(config.root, config.output.baseline ?? `${config.output.dir}/report.json`);
  if (!fileExists(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isReport(parsed) ? parsed : undefined;
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
  const host = createProgramHost(config.root, config.tsconfig, [...surfaceFiles, ...testFiles]);
  const { parser, configMessages } = createTsdocParser(config.root);
  const surface = extractSurface(host, config, parser, surfaceFiles, testFiles);
  const testExtraction = extractTests(config, testFiles);

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

  const docMessages = [
    ...surface.docMessages,
    ...configMessages.map((text) => ({ file: "tsdoc.json", line: 1, text })),
  ];
  const baseline = loadBaseline(config, options.baseline);
  const findings = evaluateRules({
    config,
    units,
    tests: testExtraction.tests,
    unlinked: testExtraction.unlinked,
    docMessages,
    baseline,
    strayGuarantees: surface.strayGuarantees,
    surfaceFileCount: surfaceFiles.length,
  });

  const guarantees = units.flatMap((u) => u.guarantees);
  const guaranteeKeys = new Set(guarantees.map((g) => g.key));
  const report: Report = {
    $schema: "https://raw.githubusercontent.com/marbull-x-inc/specgate/main/schema/ir.schema.json",
    version: "1",
    tool: { ...TOOL },
    generatedAt: new Date().toISOString(),
    root: config.root,
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
    },
  };
  return { report, extracted: surface.units, host, surfaceFiles, testFiles };
}

/** Exit code policy: blocking mode fails on any `fail` finding; advisory always exits 0. */
export function exitCodeFor(report: Report, strict = false): number {
  if (report.mode === "advisory" && !strict) return 0;
  return report.summary.findings.fail > 0 ? 1 : 0;
}
