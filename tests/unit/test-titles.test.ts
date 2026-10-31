import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "../../src/config/schema.ts";
import { extractTests, matchTitle } from "../../src/extract/tests/index.ts";
import { workDir } from "../helpers/paths.ts";

const idPattern = new RegExp(defineConfig({}).ids.pattern);

describe("matchTitle", () => {
  test("full key", () => {
    expect(matchTitle("QuestUseCase#createQuest.ok.recorded 正常系: …", idPattern)).toEqual({
      target: "QuestUseCase",
      operation: "createQuest",
      id: "ok.recorded",
    });
  });
  test("operation.id for a free function", () => {
    expect(matchTitle("addMoney.err.currency-mismatch throws", idPattern)).toEqual({
      target: undefined,
      operation: "addMoney",
      id: "err.currency-mismatch",
    });
  });
  test("#operation.id", () => {
    expect(matchTitle("#placeOrder.atomic all or nothing", idPattern)).toEqual({
      target: undefined,
      operation: "placeOrder",
      id: "atomic",
    });
  });
  test("bare id", () => {
    expect(matchTitle("ok.stored stores", idPattern)).toEqual({
      target: undefined,
      operation: undefined,
      id: "ok.stored",
    });
  });
  test("no id", () => {
    expect(matchTitle("should complete action successfully", idPattern)).toBeUndefined();
    expect(matchTitle("正常系: 何かする", idPattern)).toBeUndefined();
  });
});

describe("extractTests", () => {
  test("uses describe titles for target and operation, recognises todo/skip/each", () => {
    const dir = workDir("titles");
    const file = join(dir, "quest.test.ts");
    writeFileSync(
      file,
      `
describe("QuestUseCase", () => {
  describe("method createQuest()", () => {
    test("ok.recorded 正常系: saved", () => {});
    test.todo("err.duplicate 異常系: duplicate slug");
    it.skip("QuestUseCase#createQuest.frame other ports untouched", () => {});
    test.each([1, 2])("atomic k=%s", () => {});
    test("should do something unlinked", () => {});
  });
});
describe("addMoney", () => {
  test("addMoney.ok.sum adds", () => {});
});
`,
    );
    const config = defineConfig({ root: dir, tests: { include: ["*.test.ts"] } });
    const { tests, unlinked } = extractTests({ ...config, root: dir }, [file]);
    expect(tests.map((t) => [t.key, t.status])).toEqual([
      ["QuestUseCase#createQuest.ok.recorded", "test"],
      ["QuestUseCase#createQuest.err.duplicate", "todo"],
      ["QuestUseCase#createQuest.frame", "skip"],
      ["QuestUseCase#createQuest.atomic", "each"],
      ["addMoney.ok.sum", "test"],
    ]);
    expect(unlinked.map((u) => u.title)).toEqual(["should do something unlinked"]);
  });

  test("playwright adapter reads test.describe and ignores it as a test", () => {
    const dir = workDir("pw");
    const file = join(dir, "flow.spec.ts");
    writeFileSync(
      file,
      `test.describe("Checkout", () => { test.describe("placeOrder", () => { test("ok.stored shows confirmation", async () => {}); }); });`,
    );
    const config = defineConfig({ root: dir, tests: { adapter: "playwright", include: ["*.spec.ts"] } });
    const { tests } = extractTests({ ...config, root: dir }, [file], "playwright");
    expect(tests.map((t) => t.key)).toEqual(["Checkout#placeOrder.ok.stored"]);
  });

  test("optional frozen-requirement header ids are opaque strings", () => {
    const dir = workDir("req");
    const file = join(dir, "x.test.ts");
    writeFileSync(file, `// @requirement 01J9ZK3Q8W7R2M5N6P7Q8R9S0T\ntest("f.ok.x y", () => {});`);
    const on = defineConfig({ root: dir, requirementHeader: { enabled: true } });
    expect(extractTests({ ...on, root: dir }, [file]).tests[0]?.requirementIds).toEqual(["01J9ZK3Q8W7R2M5N6P7Q8R9S0T"]);
    const off = defineConfig({ root: dir });
    expect(extractTests({ ...off, root: dir }, [file]).tests[0]?.requirementIds).toEqual([]);
  });
});
