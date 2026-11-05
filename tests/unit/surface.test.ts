import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { workDir } from "../helpers/paths.ts";

/**
 * Small hand-built programs exercising surface detection away from the DDD example:
 * arrow-function exports, namespace imports, the `exported` mode and `classPattern`.
 */
function project(files: Record<string, string>): string {
  const dir = workDir("surface");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "src", name), content);
  return dir;
}

async function unitsOf(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [] },
    tests: { include: ["tests/**/*.test.ts"] },
    ...overrides,
  });
  const { report } = await analyze({ ...config, root: dir }, { provenance: false, baseline: null });
  return report;
}

const LIB = `
/** Adds. @guarantee ok.sum result = a + b */
export const add = (a: number, b: number): number => a + b;
/** Unused anywhere. @guarantee ok.x result = 1 */
export function orphanExport(): number { return 1; }
function internal(): number { return 2; }
export { internal };
export class Greeter {
  /** @guarantee ok.greets result starts with name */
  greet(name: string): string { return \`hi \${name}\`; }
  #secret(): void {}
  private helper(): void {}
}
export class Dto { value = 1; }
`;

describe("surface extraction", () => {
  test("referenced mode: arrow exports and namespace imports count, unreferenced exports do not", async () => {
    const dir = project({
      "lib.ts": LIB,
      "main.ts": `import * as lib from "./lib.ts";\nexport const r = lib.add(1, 2);\n`,
    });
    const report = await unitsOf(dir);
    const ids = report.units.map((u) => u.id).sort();
    // A namespace import marks every export of the module as referenced.
    expect(ids).toEqual(["Dto", "Greeter#greet", "add", "internal", "orphanExport"].filter((i) => i !== "Dto"));
    expect(report.units.find((u) => u.id === "add")?.kind).toBe("function");
    expect(report.units.find((u) => u.id === "Greeter#greet")?.referencedBy).toEqual(["src/main.ts"]);
  });

  test("referenced mode with named imports: only the imported names are units", async () => {
    const dir = project({ "lib.ts": LIB, "main.ts": `import { add } from "./lib.ts";\nexport const r = add(1, 2);\n` });
    const report = await unitsOf(dir);
    expect(report.units.map((u) => u.id)).toEqual(["add"]);
  });

  test("exported mode lists every export regardless of use; classPattern narrows classes", async () => {
    const dir = project({ "lib.ts": LIB });
    const all = await unitsOf(dir, { surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" } });
    expect(all.units.map((u) => u.id).sort()).toEqual(["Greeter#greet", "add", "internal", "orphanExport"]);
    const narrowed = await unitsOf(dir, {
      surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported", classPattern: "UseCase$" },
    });
    expect(narrowed.units.map((u) => u.id).sort()).toEqual(["add", "internal", "orphanExport"]);
  });

  test("private helpers reached through this.x() contribute their port calls and thrown errors", async () => {
    const dir = project({
      "uc.ts": `
export interface Repo { save(v: string): Promise<void>; load(): Promise<string> }
export class Uc {
  constructor(private readonly repo: Repo) {}
  /** @uses Repo @modifies Repo @guarantee ok.saved Repo holds v */
  async run(v: string): Promise<void> { await this.step(v); }
  private async step(v: string): Promise<void> { if (!v) throw new RangeError("empty"); await this.repo.save(v); }
}
`,
      "main.ts": `import { Uc } from "./uc.ts";\nexport const u = Uc;\n`,
    });
    const report = await unitsOf(dir);
    const run = report.units.find((u) => u.id === "Uc#run");
    expect(run?.portCalls).toEqual([{ port: "repo", member: "save", count: 1 }]);
    expect(run?.injectedPorts).toEqual([{ member: "repo", type: "Repo", members: ["save", "load"] }]);
    expect(report.findings.filter((f) => f.rule === "uses-mismatch")).toEqual([]);
  });

  // #63: hooks libraries export each operation as the module's default.
  const DEFAULTS = {
    "counter.ts": `
/** @guarantee ok.initial the value starts at initialValue */
const useCounter = (initialValue = 0): number => (initialValue > 10 ? 10 : initialValue);
export default useCounter;
`,
    "bool.ts": `
/** @guarantee ok.default the state starts at defaultValue */
export default function useBoolean(defaultValue = false): boolean { return defaultValue; }
`,
  };

  test("a declaration exported only as default is a unit named after the declaration", async () => {
    const dir = project(DEFAULTS);
    const report = await unitsOf(dir, { surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" } });
    expect(report.units.map((u) => u.id).sort()).toEqual(["useBoolean", "useCounter"]);
    expect(report.units.find((u) => u.id === "useCounter")?.decisions.map((d) => d.values)).toContainEqual(["10"]);
    const misplaced = report.findings.filter((f) => f.rule === "guarantee-on-non-unit" || f.rule === "surface-empty");
    expect(misplaced).toEqual([]);
  });

  test("a default import counts as a reference, and test keys name the declaration", async () => {
    const dir = project({
      ...DEFAULTS,
      "main.ts": `import useCounter from "./counter.ts";\nimport useBoolean from "./bool.ts";\nexport const r = [useCounter(1), useBoolean()];\n`,
    });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "tests", "counter.test.ts"),
      `import { test, expect } from "bun:test";\nimport useCounter from "../src/counter.ts";\ntest("useCounter.ok.initial starts at the given value", () => { expect(useCounter(3)).toBe(3); });\n`,
    );
    const report = await unitsOf(dir);
    expect(report.units.map((u) => u.id).sort()).toEqual(["useBoolean", "useCounter"]);
    expect(report.units.find((u) => u.id === "useCounter")?.referencedBy).toEqual(["src/main.ts"]);
    const found = report.findings.map((f) => `${f.rule} ${f.guarantee ?? ""}`);
    expect(found).not.toContain("guarantee-no-test useCounter.ok.initial");
    expect(found.filter((f) => f.startsWith("test-orphan"))).toEqual([]);
  });
});
