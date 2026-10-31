import { describe, expect, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { loadConfig } from "../../src/config/load.ts";
import type { TestAdapter } from "../../src/config/schema.ts";
import { generateTests, mirrorPath } from "../../src/gen/index.ts";
import { EXAMPLE_SHOP, workDir } from "../helpers/paths.ts";

async function dryRun(adapter: TestAdapter, importExtension: "" | ".ts" | ".js" = "") {
  const repo = join(workDir(`gen-${adapter}`), "shop");
  cpSync(EXAMPLE_SHOP, repo, { recursive: true });
  rmSync(join(repo, "tests"), { recursive: true, force: true });
  const { config: base } = await loadConfig(repo);
  const config = { ...base, tests: { ...base.tests, adapter, importExtension, prefixes: { ok: "OK:", err: "ERR:" } } };
  const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
  const result = generateTests(config, extracted, report.vocabulary.entities, { dryRun: true });
  const file = (suffix: string) => result.written.find((w) => w.path.endsWith(suffix))?.content ?? "";
  return { result, file, config };
}

describe("generateTests adapters", () => {
  test("vitest: framework import, prefixes from config, bare import specifiers", async () => {
    const { file } = await dryRun("vitest");
    const place = file("application/place-order.test.ts");
    expect(place).toContain('import { describe, expect, test } from "vitest";');
    expect(place).toContain('import { PlaceOrderUseCase } from "../../src/application/place-order";');
    expect(place).toContain('"PlaceOrderUseCase#placeOrder.err.empty ERR: items is empty; no state changes"');
    expect(place).toContain('test.todo("PlaceOrderUseCase#placeOrder.ok.stored OK: ');
  });

  test("jest with .js import extension (NodeNext projects)", async () => {
    const { file } = await dryRun("jest", ".js");
    expect(file("domain/period.test.ts")).toContain('import { isWithinPeriod } from "../../src/domain/period.js";');
    expect(file("domain/period.test.ts")).toContain('from "@jest/globals"');
  });

  test("playwright: test.describe and fixme instead of todo", async () => {
    const { file } = await dryRun("playwright");
    const period = file("domain/period.test.ts");
    expect(period).toContain('import { expect, test } from "@playwright/test";');
    expect(period).toContain('test.describe("isWithinPeriod", () => {');
    expect(period).toMatch(/test\.fixme\("isWithinPeriod\.ok\.within .*", async \(\) => \{\}\);/);
    expect(period).not.toContain("test.todo(");
  });

  test("dry run writes nothing and lists every file it would create", async () => {
    const { result, config } = await dryRun("bun", ".ts");
    expect(result.written.every((w) => w.action === "created")).toBe(true);
    expect(result.written.map((w) => w.path)).toContain(mirrorPath(config, "src/domain/money.ts", ".doctest.test.ts"));
    expect(result.written.map((w) => w.path)).toContain(mirrorPath(config, "src/domain/money.ts", ".property.test.ts"));
  });
});

describe("mirrorPath", () => {
  test("maps the source tree onto the mirror root, keeping files outside `from` under `to`", async () => {
    const { config } = await dryRun("bun");
    expect(mirrorPath(config, "src/application/place-order.ts")).toBe(
      join(config.root, "tests/application/place-order.test.ts"),
    );
    expect(mirrorPath(config, "lib/other.ts")).toBe(join(config.root, "tests/lib/other.test.ts"));
  });
});
