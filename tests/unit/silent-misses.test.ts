import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { extractTests } from "../../src/extract/tests/index.ts";
import { generateTests } from "../../src/gen/index.ts";
import type { Finding } from "../../src/ir/schema.ts";
import { workDir } from "../helpers/paths.ts";

/** Regression tests for results that used to go wrong without any finding. */

const TSCONFIG = {
  compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
  include: ["src/**/*.ts"],
};

function project(files: Record<string, string>, tsconfig: object = TSCONFIG): string {
  const dir = workDir("silent");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function configFor(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"], adapter: "bun" },
    ...overrides,
  });
  return { ...config, root: dir };
}

async function run(dir: string, overrides: ConfigInput = {}) {
  return analyze(configFor(dir, overrides), { provenance: false, baseline: null });
}

const rulesOf = (findings: readonly Finding[], rule: string): Finding[] => findings.filter((f) => f.rule === rule);

describe("tsconfig with project references", () => {
  test("a solution-style tsconfig still yields the sources", async () => {
    const dir = project(
      { "src/a.ts": "/** @guarantee ok.one result is 1 */\nexport function one(): number { return 1; }\n" },
      { files: [], references: [{ path: "./tsconfig.src.json" }] },
    );
    writeFileSync(
      join(dir, "tsconfig.src.json"),
      JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, composite: true } }),
    );
    const { report } = await run(dir);
    expect(report.units.map((u) => u.id)).toEqual(["one"]);
  });
});

describe("surface-empty", () => {
  test("says when files matched but no unit was extracted, and when nothing matched", async () => {
    const dir = project({ "src/index.ts": "export function one(): number { return 1; }\n" });
    const excluded = await run(dir, { surface: { include: ["src/**/*.ts"], exclude: ["**/index.ts"] } });
    expect(rulesOf(excluded.report.findings, "surface-empty")[0]?.message).toContain("matched no file");
    const referenced = await run(dir, { surface: { include: ["src/**/*.ts"], exclude: [], mode: "referenced" } });
    expect(rulesOf(referenced.report.findings, "surface-empty")[0]?.message).toContain("1 surface file(s) matched");
  });
});

describe("functions produced by an expression", () => {
  test("export const f = factory() is a unit, with the signature from the checker", async () => {
    const dir = project({
      "src/defu.ts": `
export function createMerger(): (a: object, b?: object) => object {
  return (a, b) => ({ ...b, ...a });
}
/** @guarantee ok.left-wins keys of \`a\` win over \`b\` */
export const merge = createMerger();
/** @guarantee ok.alias same as merge */
export const mergeAs = createMerger() as (a: object, b?: object) => object;
export const VERSION = "1";
`,
    });
    const { report } = await run(dir);
    const merge = report.units.find((u) => u.id === "merge");
    expect(merge?.guarantees.map((g) => g.id)).toEqual(["ok.left-wins"]);
    expect(merge?.params.map((p) => [p.name, p.optional])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(report.units.some((u) => u.id === "mergeAs")).toBe(true);
    expect(report.units.some((u) => u.id === "VERSION")).toBe(false);
  });
});

describe("guarantee-on-non-unit", () => {
  test("a @guarantee that does not belong to a unit is reported with the reason", async () => {
    const dir = project({
      "src/x.ts": `
/** @guarantee ok.hidden never checked */
function hidden(): number { return 1; }
export const use = (): number => hidden();
/** @guarantee ok.cls on the class */
export class Box {
  /** @guarantee ok.secret private */
  private secret(): number { return 1; }
  /** @guarantee ok.open public */
  open(): number { return this.secret(); }
}
/** @guarantee ok.alias a type */
export type Alias = string;
`,
    });
    const { report } = await run(dir);
    const messages = rulesOf(report.findings, "guarantee-on-non-unit").map((f) => f.message);
    expect(messages).toHaveLength(4);
    expect(messages.find((m) => m.startsWith("hidden "))).toContain("not exported");
    expect(messages.find((m) => m.startsWith("Box "))).toContain("public methods");
    expect(messages.find((m) => m.startsWith("Box#secret"))).toContain("not public");
    expect(messages.find((m) => m.startsWith("Alias "))).toContain("type aliases");
    expect(rulesOf(report.findings, "guarantee-on-non-unit")[0]?.severity).toBe("fail");
    expect(report.units.find((u) => u.id === "Box#open")?.guarantees.map((g) => g.id)).toEqual(["ok.open"]);
  });
});

describe("overloads", () => {
  test("signatures and implementation are one unit; guarantees on every signature count", async () => {
    const dir = project({
      "src/ms.ts": `
/** @guarantee ok.parse a string is parsed */
export function ms(value: string): number;
/** @guarantee ok.format a number is formatted */
export function ms(value: number): string;
export function ms(value: string | number): string | number {
  return typeof value === "string" ? value.length : String(value);
}
export class Clock {
  /** @guarantee ok.no-arg now */
  at(): number;
  /** @guarantee ok.arg given */
  at(t: number): number;
  at(t?: number): number { return t ?? 0; }
}
`,
    });
    const { report } = await run(dir);
    const ms = report.units.filter((u) => u.id === "ms");
    expect(ms).toHaveLength(1);
    expect(ms[0]?.guarantees.map((g) => g.id)).toEqual(["ok.parse", "ok.format"]);
    expect(ms[0]?.line).toBe(3);
    const at = report.units.filter((u) => u.id === "Clock#at");
    expect(at).toHaveLength(1);
    expect(at[0]?.guarantees.map((g) => g.id)).toEqual(["ok.no-arg", "ok.arg"]);
    expect(rulesOf(report.findings, "guarantee-id-duplicate")).toEqual([]);
  });
});

describe("gen", () => {
  const SOURCE = `
/** @guarantee ok.one result is 1 */
export function one(): number { return 1; }
/** @guarantee ok.two result is 2 */
export function two(): number { return 2; }
/** @guarantee ok.three result is 3 */
export function three(): number { return 3; }
`;
  test("a first run writes one file: one import block and one describe per unit", async () => {
    const dir = project({ "src/n.ts": SOURCE });
    const config = configFor(dir);
    const { extracted, report } = await run(dir);
    const result = generateTests(config, extracted, report.vocabulary.entities);
    expect(result.written.filter((w) => w.path.endsWith("tests/n.test.ts")).map((w) => w.action)).toEqual(["created"]);
    const content = readFileSync(join(dir, "tests/n.test.ts"), "utf8");
    expect(content.match(/from "bun:test"/g)).toHaveLength(1);
    expect(content).toContain('import { one, two, three } from "../src/n";');
    expect(content).not.toContain("(specgate)");
    expect(content.match(/describe\(/g)).toHaveLength(3);
  });

  test("a rerun after reformatting (single quotes) adds no import, and a test in another file counts", async () => {
    const dir = project({ "src/n.ts": SOURCE });
    const config = configFor(dir);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "tests/n.test.ts"),
      `import { describe, expect, test } from 'bun:test';\nimport { one } from '../src/n';\n\ndescribe('one', () => {\n  test('one.ok.one is 1', () => {\n    expect(one()).toBe(1);\n  });\n});\n`,
    );
    writeFileSync(
      join(dir, "tests/elsewhere.test.ts"),
      `import { expect, test } from 'bun:test';\nimport { two } from '../src/n';\ntest('two.ok.two is 2', () => {\n  expect(two()).toBe(2);\n});\n`,
    );
    const { extracted, report } = await run(dir);
    generateTests(config, extracted, report.vocabulary.entities);
    const content = readFileSync(join(dir, "tests/n.test.ts"), "utf8");
    expect(content).not.toContain('from "bun:test"');
    expect(content.match(/import \{ (one|three)/g)).toEqual(["import { one", "import { three"]);
    expect(content).toContain("three.ok.three");
    expect(content).not.toContain("two.ok.two");
  });
});

describe("small misreadings", () => {
  test("new Date(value) converts, new Date() reads the clock", async () => {
    const dir = project({
      "src/d.ts": `
/** @guarantee ok.copy a copy */
export function copy(d: Date): Date { return new Date(d.getTime()); }
/** @guarantee ok.now the time */
export function now(): Date { return new Date(); }
`,
    });
    const { report } = await run(dir);
    expect(rulesOf(report.findings, "env-input-direct").map((f) => f.unit)).toEqual(["now"]);
  });

  test("a lone kind word as a title is not a key", () => {
    const dir = workDir("bare");
    const file = join(dir, "x.test.ts");
    writeFileSync(file, `it("ok", () => {});\nit("ok.stored stored", () => {});\n`);
    const { tests, unlinked } = extractTests(defineConfig({ root: dir }), [file]);
    expect(tests.map((t) => t.key)).toEqual(["ok.stored"]);
    expect(unlinked.map((u) => u.title)).toEqual(["ok"]);
  });

  test("undeclared acronyms are prose; undeclared SCREAMING_CASE is not", async () => {
    const dir = project({
      "src/a.ts":
        "/** @guarantee ok.x per the README, ESM and HTTP, MAX_RETRIES times */\nexport function x(): void {}\n",
    });
    const { report } = await run(dir);
    const unresolved = report.units[0]?.guarantees[0]?.references
      .filter((r) => r.kind === "unresolved")
      .map((r) => r.raw);
    expect(unresolved).toEqual(["MAX_RETRIES"]);
  });
});
