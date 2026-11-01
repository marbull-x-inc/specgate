import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { loadConfig } from "../../src/config/load.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { extractTests, stripTitlePrefix } from "../../src/extract/tests/index.ts";
import { generateTests } from "../../src/gen/index.ts";
import { resolveReferences } from "../../src/resolve/identifiers.ts";
import { EXAMPLE_SHOP, workDir } from "../helpers/paths.ts";

/** Regression tests for the issues found in the first adoption (marbull-x-inc/specgate#4 … #9). */

function project(files: Record<string, string>): string {
  const dir = workDir("feedback");
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

async function reportOf(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
    ...overrides,
  });
  return (await analyze({ ...config, root: dir }, { provenance: false, baseline: null })).report;
}

describe("#4 a configured prefix may precede the key", () => {
  test("stripTitlePrefix removes the longest matching prefix", () => {
    expect(stripTitlePrefix("異常系: Uc#op.err.x text", ["正常系:", "異常系:"])).toBe("Uc#op.err.x text");
    expect(stripTitlePrefix("  正常系:Uc#op.ok.x", ["正常系:"])).toBe("Uc#op.ok.x");
    expect(stripTitlePrefix("Uc#op.ok.x text", ["正常系:"])).toBe("Uc#op.ok.x text");
  });
  test("extractTests links titles that carry the prefix first", () => {
    const dir = workDir("prefix");
    const file = join(dir, "x.test.ts");
    writeFileSync(
      file,
      `test("異常系: Uc#op.err.race 並列実行", () => {});\ntest("正常系: ok.stored stored", () => {});\n`,
    );
    const config = defineConfig({ root: dir, tests: { prefixes: { ok: "正常系:", err: "異常系:" } } });
    const { tests, unlinked } = extractTests({ ...config, root: dir }, [file]);
    expect(tests.map((t) => t.key)).toEqual(["Uc#op.err.race", "ok.stored"]);
    expect(unlinked).toEqual([]);
  });
  test("gen emits the prefix before the key so generated titles satisfy the same rule", async () => {
    const repo = join(workDir("gen-prefix"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    const { config: base } = await loadConfig(repo);
    const config = { ...base, tests: { ...base.tests, prefixes: { ok: "正常系:", err: "異常系:" } } };
    const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
    const result = generateTests(config, extracted, report.vocabulary.entities, { dryRun: true });
    const period = result.written.find((w) => w.path.endsWith("domain/period.test.ts"))?.content ?? "";
    expect(period).toContain('"正常系: isWithinPeriod.ok.within ');
    expect(period).not.toContain('"isWithinPeriod.ok.within 正常系:');
  });
});

describe("#5 env-input-direct follows private helpers", () => {
  test("a new Date() inside a helper reached through this.x() is attributed to the public unit", async () => {
    const dir = project({
      "uc.ts": `
export class Uc {
  /** @guarantee ok.x result = 1 */
  run(): number { return this.stamp(); }
  private stamp(): number { return new Date().getTime(); }
  private unused(): number { return Date.now(); }
}
export const keep = Uc;
`,
    });
    const report = await reportOf(dir);
    const run = report.units.find((u) => u.id === "Uc#run");
    expect(run?.envInputs.map((e) => [e.expression, e.line])).toEqual([["new Date", 5]]);
  });
});

describe("#6 Target#operation outside the surface", () => {
  test("resolves against any class or interface in the program as an external operation", async () => {
    const dir = project({
      "rules.ts": `export class QuestCompletionService { static checkActivityConstraints(): boolean { return true; } private static hidden(): void {} }`,
      "uc.ts": `
import { QuestCompletionService } from "./rules.ts";
export class Uc {
  /** @guarantee err.limit QuestCompletionService#checkActivityConstraints の規則で完了不可のとき throw; QuestCompletionService#hidden は無い */
  run(): boolean { return QuestCompletionService.checkActivityConstraints(); }
}
export const keep = Uc;
`,
    });
    const report = await reportOf(dir, { surface: { include: ["src/uc.ts"], exclude: [], mode: "exported" } });
    const refs = report.units[0]?.guarantees[0]?.references ?? [];
    expect(refs).toContainEqual({
      raw: "QuestCompletionService#checkActivityConstraints",
      kind: "operation",
      target: "QuestCompletionService#checkActivityConstraints",
    });
    expect(refs).toContainEqual({ raw: "QuestCompletionService#hidden", kind: "unresolved" });
  });
});

describe("#7 long todo lines are wrapped", () => {
  test("a todo over tests.lineWidth is split like a formatter would", async () => {
    const repo = join(workDir("gen-width"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    const { config: base } = await loadConfig(repo);
    const config = { ...base, tests: { ...base.tests, lineWidth: 60 } };
    const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
    const result = generateTests(config, extracted, report.vocabulary.entities, { dryRun: true });
    const period = result.written.find((w) => w.path.endsWith("domain/period.test.ts"))?.content ?? "";
    expect(period).toContain('  test.todo(\n    "isWithinPeriod.ok.within ');
    expect(period).toMatch(/",\n {2}\);\n/);
    const wide = { ...base, tests: { ...base.tests, lineWidth: 400 } };
    const wideResult = generateTests(wide, extracted, report.vocabulary.entities, { dryRun: true });
    expect(wideResult.written.find((w) => w.path.endsWith("domain/period.test.ts"))?.content).toContain(
      '  test.todo("isWithinPeriod.ok.within ',
    );
  });
});

describe("#8 appending emits skeletons and the imports they need", () => {
  test("an existing file gets the throws skeleton, stubs and only the imports it lacks", async () => {
    const repo = join(workDir("append"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    const { config } = await loadConfig(repo);
    const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
    generateTests(config, extracted, report.vocabulary.entities, { now: new Date("2026-01-01T15:00:00Z") });
    const place = readFileSync(join(repo, "tests/application/place-order.test.ts"), "utf8");
    // the file already imported describe/expect/test from @jest/globals: no second framework import
    expect(place.match(/from "@jest\/globals"/g)).toHaveLength(1);
    // imports the appended skeletons need, inserted after the existing imports, before the first describe
    expect(place).toContain(
      'import { createFaultRunner, createStub, fakeClock, faultRunnerControl, snapshotAll, stubReset } from "@marbull-x-inc/specgate/runtime";',
    );
    expect(place).toContain('import { PlaceOrderUseCase } from "../../src/application/place-order";');
    expect(place.indexOf('from "@marbull-x-inc/specgate/runtime"')).toBeLessThan(
      place.indexOf('describe("PlaceOrderUseCase"'),
    );
    // skeletons inside the appended block, with the arrangement scoped to it
    const appended = place.slice(place.indexOf("(specgate)"));
    expect(appended).toContain("const sut = new PlaceOrderUseCase(tx, orders, notifications, clock);");
    expect(appended).toContain("faultRunnerControl(tx).failurePoints()");
    expect(appended).toContain('test.todo(\n    "PlaceOrderUseCase#placeOrder.ok.notified ');
    // err.empty already had a test (todo) in the file, so it is not appended again
    expect(appended).not.toContain("rejects.toThrow(EmptyOrderError)");
  });
  test("names the file already binds are not imported twice", async () => {
    const repo = join(workDir("append2"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    const existing = join(repo, "tests/application/place-order.test.ts");
    writeFileSync(
      existing,
      `import { describe, expect, it } from "@jest/globals";
import { PlaceOrderUseCase } from "../../src/application/place-order";
import type { Clock } from "../../src/ports/clock";

describe("PlaceOrderUseCase", () => {
  it("placeOrder.ok.stored existing", () => { expect(PlaceOrderUseCase).toBeDefined(); });
});
`,
    );
    const { config } = await loadConfig(repo);
    const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
    generateTests(config, extracted, report.vocabulary.entities);
    const place = readFileSync(existing, "utf8");
    expect(place.match(/PlaceOrderUseCase \} from/g)).toHaveLength(1);
    expect(place.match(/import type \{ Clock \}/g)).toHaveLength(1);
    expect(place).toContain('import type { NotificationGateway } from "../../src/ports/notification-gateway";');
  });
});

describe("#9 rough edges", () => {
  test("the appended comment carries the local date", async () => {
    const repo = join(workDir("date"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    const { config } = await loadConfig(repo);
    const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
    const now = new Date(2026, 10, 1, 0, 30); // local 2026-11-01 00:30, whatever the zone
    generateTests(config, extracted, report.vocabulary.entities, { now });
    expect(readFileSync(join(repo, "tests/domain/money.test.ts"), "utf8")).toContain("specgate gen (2026-11-01)");
  });
  test("code spans are not identifier-resolved", () => {
    const unit = { ...baseUnit(), params: [] };
    const scope = { units: [unit], entities: [], ports: [], programTypeNames: new Set<string>() };
    const refs = resolveReferences(
      unit,
      "ports outside `@modifies` and `SomeType.member` are unchanged; Plain.Dotted is",
      scope,
      defineConfig({}),
    );
    expect(refs.map((r) => r.raw)).toEqual(["Plain.Dotted"]);
  });
  test("surface.operationPattern limits which operations are units", async () => {
    const dir = project({
      "uc.ts": `
export class Uc {
  /** @guarantee ok.x result = 1 */
  run(): number { return 1; }
  other(): number { return 2; }
}
export function helperFn(): number { return 3; }
`,
    });
    const all = await reportOf(dir);
    expect(all.units.map((u) => u.id).sort()).toEqual(["Uc#other", "Uc#run", "helperFn"]);
    const narrowed = await reportOf(dir, {
      surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported", operationPattern: "^run$" },
    });
    expect(narrowed.units.map((u) => u.id)).toEqual(["Uc#run"]);
    expect(narrowed.findings.filter((f) => f.rule === "operation-no-guarantee")).toEqual([]);
  });
});

function baseUnit() {
  return {
    id: "Uc#op",
    kind: "method" as const,
    target: "Uc",
    operation: "op",
    file: "src/uc.ts",
    line: 1,
    endLine: 2,
    referencedBy: [],
    summary: "",
    params: [],
    returns: "void",
    uses: [],
    modifies: [],
    injectedPorts: [],
    portCalls: [],
    operationCalls: [],
    envInputs: [],
    decisions: [],
    implHash: "",
    guarantees: [],
    examples: [],
    hasDoc: true,
  };
}
