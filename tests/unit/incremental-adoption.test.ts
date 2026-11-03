import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAccepted } from "../../src/accepted.ts";
import { analyze, exitCodeFor } from "../../src/analyze.ts";
import { scaffoldDocs } from "../../src/commands/scaffold.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { workDir } from "../helpers/paths.ts";

function project(source: string): string {
  const dir = workDir("adopt");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), source);
  return dir;
}

function configFor(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
    ...overrides,
  });
  return { ...config, root: dir };
}

const JSDOC = `
/**
 * @name addMonths
 * @category Month Helpers
 * @summary Add months.
 * @param {Date} date - The date
 * @param [amount] The amount
 * @returns The new date
 * @throws RangeError if amount is not finite
 * @throws \`TypeError\` when date is not a Date
 * @throws \`date\` must not be Invalid Date
 * @throws \`options.in\` must be a function
 * @example
 * addMonths(new Date(2020, 0, 31), 1) // => { year: 2020 }
 */
export function addMonths(date: Date, amount?: number): Date {
  return new Date(date.getTime() + (amount ?? 0));
}
`;

describe("JSDoc-style docs", () => {
  test("tsdoc-syntax is warn by default, and silent for JSDoc conventions with tsdoc.jsdoc", async () => {
    const dir = project(JSDOC);
    const strict = (await analyze(configFor(dir), { provenance: false, baseline: null })).report;
    const syntax = strict.findings.filter((f) => f.rule === "tsdoc-syntax");
    expect(syntax.length).toBeGreaterThan(0);
    expect(syntax.every((f) => f.severity === "warn")).toBe(true);
    const lenient = (await analyze(configFor(dir, { tsdoc: { jsdoc: true } }), { provenance: false, baseline: null }))
      .report;
    expect(lenient.findings.filter((f) => f.rule === "tsdoc-syntax")).toEqual([]);
  });

  test("@throws without an id gets err.<error-type>, numbered when repeated", async () => {
    const dir = project(JSDOC);
    const { report } = await analyze(configFor(dir, { tsdoc: { jsdoc: true } }), { provenance: false, baseline: null });
    const g = report.units[0]?.guarantees ?? [];
    expect(g.map((x) => [x.id, x.throws, x.text])).toEqual([
      ["err.range-error", "RangeError", "if amount is not finite"],
      ["err.type-error", "TypeError", "when date is not a Date"],
      ["err.error", undefined, "`date` must not be Invalid Date"],
      ["err.error-2", undefined, "`options.in` must be a function"],
    ]);
    expect(report.findings.filter((f) => f.rule.startsWith("guarantee-id"))).toEqual([]);
    const off = (await analyze(configFor(dir, { ids: { deriveThrows: false } }), { provenance: false, baseline: null }))
      .report;
    expect(off.findings.some((f) => f.rule === "guarantee-id-invalid")).toBe(true);
  });
});

describe("scaffold drafts from the existing doc", () => {
  test("@returns seeds the guarantee; no port wording without ports; documented throws are not repeated", async () => {
    const dir = project(`
export class NotFound extends Error {}
/**
 * Finds a user.
 * @returns the user whose id is \`id\`
 */
export function find(id: string): string {
  if (id === "") throw new NotFound();
  return id;
}
`);
    const config = configFor(dir, { ids: { deriveThrows: false } });
    const { extracted } = await analyze(config, { provenance: false, baseline: null });
    const [edit] = scaffoldDocs(config, extracted, { dryRun: true }).edits;
    expect(edit?.text).toContain("@guarantee TODO returns the user whose id is `id`");
    expect(edit?.text).toContain("@throws {@link NotFound} TODO when NotFound is thrown");
    expect(edit?.text).not.toMatch(/ports|modifies/);
  });
});

describe("accepted findings", () => {
  test("accepted findings become info; new ones still fail; fixed ones drop out on re-accept", async () => {
    const dir = project("export function a(): number { return 1; }\n");
    const config = configFor(dir, { mode: "blocking" });
    const first = (await analyze(config, { provenance: false, baseline: null })).report;
    expect(exitCodeFor(first)).toBe(1);
    const { count } = writeAccepted(config, first.findings);
    expect(count).toBe(1);

    const accepted = (await analyze(config, { provenance: false, baseline: null })).report;
    expect(exitCodeFor(accepted)).toBe(0);
    expect(accepted.findings[0]).toMatchObject({ rule: "operation-no-guarantee", severity: "info", accepted: true });

    // a new operation is a new finding; moving the old one (other line) keeps it accepted
    writeFileSync(
      join(dir, "src", "lib.ts"),
      "\n\nexport function a(): number { return 1; }\nexport function b(): void {}\n",
    );
    const later = (await analyze(config, { provenance: false, baseline: null })).report;
    expect(later.findings.filter((f) => f.severity === "fail").map((f) => f.unit)).toEqual(["b"]);
    expect(exitCodeFor(later)).toBe(1);

    // a fixed finding drops out of the file when it is rewritten
    writeFileSync(join(dir, "src", "lib.ts"), "export function b(): void {}\n");
    const fixed = (await analyze(config, { provenance: false, baseline: null })).report;
    writeAccepted(config, fixed.findings);
    const file: unknown = JSON.parse(readFileSync(join(dir, "specgate.accepted.json"), "utf8"));
    expect(JSON.stringify(file)).not.toContain("|a|");
    expect(JSON.stringify(file)).toContain("|b|");
  });
});
