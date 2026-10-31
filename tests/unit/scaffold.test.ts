import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { scaffoldDocs } from "../../src/commands/scaffold.ts";
import { loadConfig } from "../../src/config/load.ts";
import { EXAMPLE_SHOP, workDir } from "../helpers/paths.ts";

describe("scaffoldDocs", () => {
  test("dry run reports edits without touching files; unit filter narrows them", async () => {
    const repo = join(workDir("scaffold"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    const { config } = await loadConfig(repo);
    const { extracted } = await analyze(config, { provenance: false, baseline: null });
    const before = readFileSync(join(repo, "src/application/cancel-order.ts"), "utf8");

    const all = scaffoldDocs(config, extracted, { dryRun: true });
    expect(all.edits.map((e) => [e.unit, e.kind])).toEqual([
      ["CancelOrderUseCase#cancelOrder", "insert-doc"],
      ["Clock", "add-tags"],
      ["NotificationGateway", "add-tags"],
      ["TransactionRunner", "add-tags"],
    ]);
    expect(readFileSync(join(repo, "src/application/cancel-order.ts"), "utf8")).toBe(before);

    const one = scaffoldDocs(config, extracted, { dryRun: true, unitFilter: "CancelOrderUseCase" });
    expect(one.edits).toHaveLength(1);
    const text = one.edits[0]?.text ?? "";
    // Signature-derived facts only; prose stays a placeholder.
    expect(text).toContain("@param orderId - TODO (string)");
    expect(text).toContain("@throws {@link OrderNotFoundError} TODO");
    expect(text).toContain("@uses TransactionRunner, OrderRepository");
    expect(text).toContain("@modifies TODO");
    expect(text).not.toContain("@returns"); // Promise<void> has nothing to document
    // Indentation follows the method.
    expect(text.startsWith("  /**\n   * ")).toBe(true);
  });

  test("writing is idempotent: a second run finds nothing to scaffold", async () => {
    const repo = join(workDir("scaffold2"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    const { config } = await loadConfig(repo);
    const first = await analyze(config, { provenance: false, baseline: null });
    expect(scaffoldDocs(config, first.extracted).edits.length).toBeGreaterThan(0);
    const second = await analyze(config, { provenance: false, baseline: null });
    expect(scaffoldDocs(config, second.extracted).edits).toEqual([]);
  });
});
