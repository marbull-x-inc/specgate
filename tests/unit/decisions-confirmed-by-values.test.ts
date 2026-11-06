import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyze, TOOL } from "../../src/analyze.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { listValueMutants, type ValueMutant } from "../../src/mutants/index.ts";
import { workDir } from "../helpers/paths.ts";

/**
 * #61: a value report (#60) confirms a decision when a test failed on the change of its value.
 * Such a decision is reported by neither `decision-unspecified` nor `decision-untested`.
 */
function project(files: Record<string, string>): string {
  const dir = workDir("confirmed");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const SOURCE = `const MODES = ["fast", "slow"];

/**
 * @guarantee ok.check returns whether the input is acceptable
 */
export function check(n: number, mode: string, word: string): boolean {
  if (n > 100) return false;
  if (/^(on|off)$/.test(word)) return true;
  return MODES.includes(mode);
}
`;

const TEST = `import { expect, test } from "bun:test";
import { check } from "../src/m";

test("ok.check accepts a small fast input", () => {
  expect(check(100, "fast", "x")).toBe(true);
});
`;

function configOf(dir: string, extra: ConfigInput = {}) {
  return {
    ...defineConfig({
      root: dir,
      surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
      tests: { include: ["tests/**/*.test.ts"] },
      decisions: { widen: true },
      ...extra,
    }),
    root: dir,
  };
}

/** A report as a value-mutant runner writes it, with a status per mutant. */
function reportOf(
  mutants: readonly ValueMutant[],
  status: (m: ValueMutant) => string,
  mutatorName = "Value",
  shift = 0,
): unknown {
  const files: Record<string, { language: string; source: string; mutants: unknown[] }> = {};
  for (const m of mutants) {
    const entry = files[m.file] ?? { language: "typescript", source: "", mutants: [] };
    files[m.file] = entry;
    entry.mutants.push({
      id: m.id,
      mutatorName,
      replacement: m.description,
      description: m.description,
      location: {
        start: { line: m.line, column: m.column + shift },
        end: { line: m.endLine, column: m.endColumn + shift },
      },
      status: status(m),
    });
  }
  return { schemaVersion: "2", thresholds: { high: 80, low: 60 }, files };
}

async function decisionFindings(dir: string, report?: unknown) {
  if (report !== undefined) writeFileSync(join(dir, "value.json"), JSON.stringify(report));
  const config = configOf(dir, report !== undefined ? { mutation: { report: "value.json" } } : {});
  const { report: out, host } = await analyze(config, { provenance: false, baseline: null });
  return {
    findings: out.findings.filter((f) => f.rule.startsWith("decision-")),
    mutants: listValueMutants(out.units, host, dir, TOOL).mutants,
  };
}

const decidedValue = (m: ValueMutant): string | undefined => m.decision?.values[0];

describe("a value report confirms decisions (#61)", () => {
  test("killed value mutants clear their decisions; survivors and other members stay", async () => {
    const dir = project({ "src/m.ts": SOURCE, "tests/m.test.ts": TEST });
    const before = await decisionFindings(dir);
    const messages = before.findings.map((f) => `${f.rule} ${f.message}`);
    expect(messages.some((m) => m.startsWith('decision-unspecified check commits to boundary "100"'))).toBe(true);
    expect(messages.some((m) => m.includes("members of MODES"))).toBe(true);
    expect(messages.some((m) => m.includes("members of regex at line 8"))).toBe(true);

    const killed = new Set(["100", "fast", "on", "off"]);
    const report = reportOf(before.mutants, (m) => (killed.has(decidedValue(m) ?? "") ? "Killed" : "Survived"));
    const after = await decisionFindings(dir, report);
    const left = after.findings.map((f) => f.message);
    expect(left.some((m) => m.includes('boundary "100"'))).toBe(false);
    expect(left.some((m) => m.includes("regex at line 8"))).toBe(false);
    // "slow" survived: the collection is still reported, with only the unconfirmed member.
    const modes = left.find((m) => m.includes("members of MODES"));
    expect(modes).toContain('"slow"');
    expect(modes).not.toContain('"fast"');
  });

  test("a stale report, a survivor or another tool's killed mutant confirms nothing", async () => {
    const dir = project({ "src/m.ts": SOURCE, "tests/m.test.ts": TEST });
    const before = await decisionFindings(dir);
    const count = before.findings.length;
    const all = (m: ValueMutant): string => (decidedValue(m) !== undefined ? "Killed" : "Survived");
    // Columns that no longer match the source: the report is stale.
    expect((await decisionFindings(dir, reportOf(before.mutants, all, "Value", 1))).findings.length).toBe(count);
    // Survived everywhere.
    expect(
      (
        await decisionFindings(
          dir,
          reportOf(before.mutants, () => "Survived"),
        )
      ).findings.length,
    ).toBe(count);
    // Killed, but not a value mutant.
    expect((await decisionFindings(dir, reportOf(before.mutants, all, "StringLiteral"))).findings.length).toBe(count);
    // And the same report, as a value report, clears them all.
    expect((await decisionFindings(dir, reportOf(before.mutants, all))).findings).toEqual([]);
  });
});
