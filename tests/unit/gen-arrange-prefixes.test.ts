import { describe, expect, test } from "bun:test";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { loadConfig } from "../../src/config/load.ts";
import { defineConfig, parseConfig } from "../../src/config/schema.ts";
import { extractTests } from "../../src/extract/tests/index.ts";
import { generateTests } from "../../src/gen/index.ts";
import { EXAMPLE_SHOP, workDir } from "../helpers/paths.ts";

async function placeOrderOutput(tests: Record<string, unknown>) {
  const repo = join(workDir("arrange"), "shop");
  cpSync(EXAMPLE_SHOP, repo, { recursive: true });
  const { config: base } = await loadConfig(repo);
  const config = { ...base, tests: { ...base.tests, ...parseConfig({ tests }).tests } };
  const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
  const result = generateTests(config, extracted, report.vocabulary.entities, {
    dryRun: true,
    unitFilter: "PlaceOrderUseCase",
  });
  return result.written.find((w) => w.path.endsWith("application/place-order.test.ts"))?.content ?? "";
}

describe("tests.arrange", () => {
  test("the SUT and ports come from the project's templates", async () => {
    const out = await placeOrderOutput({
      adapter: "jest",
      mirror: { from: "src", to: "tests-gen", suffix: ".test.ts" },
      arrange: {
        sut: "getService({Target})",
        port: 'getMock<{Port}>("{member}")',
        imports: ['import { getMock, getService } from "../helpers/container";'],
      },
    });
    expect(out).toContain("const sut = getService(PlaceOrderUseCase);");
    expect(out).toContain('const orders = getMock<OrderRepository>("orders");');
    expect(out).toContain('import { getMock, getService } from "../helpers/container";');
    expect(out).not.toContain("createStub");
    expect(out).not.toContain("new PlaceOrderUseCase(");
    // skeletons that need recording stubs fall back to todo
    expect(out).not.toContain("faultRunnerControl");
  });
});

describe("prefixes for matching and for generation", () => {
  test("prefixRules choose the generated prefix by id; titlePrefixes are only stripped", async () => {
    const tests = {
      adapter: "jest",
      mirror: { from: "src", to: "tests-gen", suffix: ".test.ts" },
      prefixes: { ok: "正常系:", err: "準正常系:" },
      titlePrefixes: ["異常系:"],
    };
    expect(await placeOrderOutput(tests)).toContain('"正常系: PlaceOrderUseCase#placeOrder.ok.notified');
    const ruled = await placeOrderOutput({ ...tests, prefixRules: [{ id: "^ok\\.notified$", prefix: "異常系:" }] });
    expect(ruled).toContain('"異常系: PlaceOrderUseCase#placeOrder.ok.notified');

    const dir = workDir("strip");
    const file = join(dir, "x.test.ts");
    writeFileSync(file, 'test("異常系: Uc#op.err.orphan 500", () => {});\n');
    const config = defineConfig({ root: dir, tests: { prefixes: { err: "準正常系:" }, titlePrefixes: ["異常系:"] } });
    expect(extractTests({ ...config, root: dir }, [file]).tests.map((t) => t.key)).toEqual(["Uc#op.err.orphan"]);
  });

  test("a prefix rule needs a valid regular expression", () => {
    expect(() => parseConfig({ tests: { prefixRules: [{ id: "(", prefix: "x" }] } })).toThrow();
    expect(() => parseConfig({ tests: { prefixRules: [{ prefix: "x" }] } })).toThrow(/prefixRules\[0\]\.id/);
  });
});
