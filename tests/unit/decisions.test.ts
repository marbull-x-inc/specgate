import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { decisionMentioned } from "../../src/extract/decisions.ts";
import type { Decision } from "../../src/ir/schema.ts";
import { workDir } from "../helpers/paths.ts";

function project(source: string): string {
  const dir = workDir("decisions");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "duration.ts"), source);
  return dir;
}

async function reportOf(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
    ...overrides,
  });
  return (await analyze({ ...config, root: dir }, { provenance: false, baseline: null })).report;
}

const SOURCE = `
const SECOND = 1000;
const DAY = SECOND * 86400;
const WEEK_MS = DAY * 7;

function unitOf(ms: number): string {
  if (ms >= WEEK_MS) return "week";
  return "day";
}

/**
 * @guarantee ok.day a duration of \`86400000\` is a "day"
 */
export function label(ms: number, kind: string): string {
  if (typeof kind === "string" && kind === "__proto__") return "";
  if (ms === 0 || ms < 1) return "none";
  return unitOf(ms);
}

class NotFoundError extends Error {}

/**
 * @guarantee err.missing an empty \`id\` returns a NotFoundError
 */
export function find(id: string): NotFoundError | boolean {
  if (id.length === 0) return new NotFoundError("Item missing");
  return typeof id === "string" && "length" in Object(id);
}

/** No guarantees: its decisions are not reported (operation-no-guarantee covers it). */
export function bare(ms: number): boolean {
  return ms > 42;
}

/**
 * @guarantee ok.weeks \`label(604800000, "x")\` is "week"
 */
export function caller(ms: number): string {
  return label(ms, "x");
}
`;

describe("decision extraction", () => {
  test("collects boundaries, constants, outputs and matches through local helpers", async () => {
    const report = await reportOf(project(SOURCE));
    const label = report.units.find((u) => u.id === "label");
    const summary = (label?.decisions ?? []).map((d) => `${d.kind}:${d.values.join(",")}:${d.names.join(",")}`);
    expect(summary).toContain("match:__proto__:");
    expect(summary).toContain("boundary:604800000:WEEK_MS");
    expect(summary).toContain("constant:604800000:WEEK_MS");
    expect(summary).toContain("constant:86400000:DAY");
    expect(summary).toContain("constant:1000:SECOND");
    expect(summary).toContain("output:week:");
    expect(summary).toContain("output:none:");
    // 0, 1 and typeof checks are not decisions
    expect(summary.some((s) => s.startsWith("match:0") || s.startsWith("boundary:1:") || s === "match:string:")).toBe(
      false,
    );
  });
});

describe("decision-unspecified", () => {
  test("error messages and the operands of a test are not outputs", async () => {
    const report = await reportOf(project(SOURCE));
    expect(report.units.find((u) => u.id === "find")?.decisions).toEqual([]);
  });

  test("reports values the contract never names, and nothing for a unit without guarantees", async () => {
    const report = await reportOf(project(SOURCE));
    const messages = report.findings.filter((f) => f.rule === "decision-unspecified").map((f) => f.message);
    const forLabel = messages.filter((m) => m.startsWith("label "));
    // "86400000" and "day" are named; the caller's contract names 604800000 and "week"
    expect(forLabel.some((m) => m.includes('"86400000"'))).toBe(false);
    expect(forLabel.some((m) => m.includes('"604800000"'))).toBe(false);
    expect(forLabel.some((m) => m.includes('output "week"'))).toBe(false);
    // never named anywhere
    expect(forLabel.some((m) => m.includes('match "__proto__"'))).toBe(true);
    expect(forLabel.some((m) => m.includes('output "none"'))).toBe(true);
    expect(forLabel.some((m) => m.includes('constant "1000"'))).toBe(true);
    expect(messages.some((m) => m.startsWith("bare "))).toBe(false);
    expect(report.findings.find((f) => f.rule === "decision-unspecified")?.severity).toBe("warn");
  });

  test("decisions.ignore accepts a value or a name as named", async () => {
    const report = await reportOf(project(SOURCE), { decisions: { ignore: ["__proto__", "SECOND"] } });
    const messages = report.findings.filter((f) => f.rule === "decision-unspecified").map((f) => f.message);
    expect(messages.some((m) => m.includes("__proto__") || m.includes("(SECOND)"))).toBe(false);
    expect(messages.some((m) => m.includes('output "none"'))).toBe(true);
  });
});

describe("decisionMentioned", () => {
  const d = (kind: Decision["kind"], values: string[], names: string[] = []): Decision => ({
    kind,
    expression: "",
    line: 1,
    values,
    names,
  });
  const none = new Set<string>();
  test("numbers match by value, whatever the notation", () => {
    for (const text of ["86400000", "86_400_000", "86,400,000", "8.64e7"])
      expect(decisionMentioned(d("constant", ["86400000"]), `returns ${text}`, none)).toBe(true);
    expect(decisionMentioned(d("constant", ["7"]), "returns 70", none)).toBe(false);
  });
  test("a string may follow a digit but not a letter", () => {
    expect(decisionMentioned(d("output", ["d"]), '`ms(86400000)` is "1d"', none)).toBe(true);
    expect(decisionMentioned(d("output", ["d"]), "one day", none)).toBe(false);
  });
  test("names count only in code spans and only from three characters", () => {
    expect(decisionMentioned(d("constant", ["604800000"], ["WEEK_MS"]), "uses `WEEK_MS`", none)).toBe(true);
    expect(decisionMentioned(d("constant", ["604800000"], ["WEEK_MS"]), "uses WEEK_MS", none)).toBe(false);
    expect(decisionMentioned(d("constant", ["2629800000"], ["mo"]), "unit `mo`", none)).toBe(false);
  });
});
