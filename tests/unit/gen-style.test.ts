import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "../../src/config/schema.ts";
import { applyQuote, resolveQuote, shortTitle } from "../../src/gen/style.ts";
import { workDir } from "../helpers/paths.ts";

describe("quote style", () => {
  test("string literals become single-quoted; templates, comments and literals with ' stay", () => {
    const code = [
      'import { a } from "./a";',
      'test("it\'s fine", () => {});',
      'test("plain \\"x\\" and \\\\ back", () => {}); // "comment"',
      'const t = `${"in template"}`;',
    ].join("\n");
    expect(applyQuote(code, "single").split("\n")).toEqual([
      "import { a } from './a';",
      'test("it\'s fine", () => {});',
      'test(\'plain "x" and \\\\ back\', () => {}); // "comment"',
      "const t = `${'in template'}`;",
    ]);
    expect(applyQuote(code, "double")).toBe(code);
  });

  test("auto reads Biome (jsonc) and Prettier configs, explicit settings win", () => {
    const biome = workDir("quote-biome");
    writeFileSync(
      join(biome, "biome.jsonc"),
      '{\n  // comment\n  "javascript": { "formatter": { "quoteStyle": "single" } }\n}\n',
    );
    expect(resolveQuote({ ...defineConfig({}), root: biome })).toBe("single");
    const prettier = workDir("quote-prettier");
    writeFileSync(join(prettier, "package.json"), JSON.stringify({ prettier: { singleQuote: true } }));
    expect(resolveQuote({ ...defineConfig({}), root: prettier })).toBe("single");
    expect(resolveQuote({ ...defineConfig({ tests: { quote: "double" } }), root: prettier })).toBe("double");
    expect(resolveQuote({ ...defineConfig({}), root: workDir("quote-none") })).toBe("double");
  });
});

describe("short titles", () => {
  test("the key stays whole, the statement is cut at a word with an ellipsis", () => {
    const head = "正常系: Order#place.ok.stored";
    const r = shortTitle(
      head,
      "after the call the repository holds an order whose total is the sum of item prices",
      70,
    );
    expect(r.title.startsWith(`${head} after the call`)).toBe(true);
    expect(r.title.endsWith("…")).toBe(true);
    expect(r.title.length).toBeLessThanOrEqual(70);
    expect(r.full).toContain("sum of item prices");
    expect(shortTitle(head, "short", 70)).toEqual({ title: `${head} short` });
    expect(shortTitle(head, "x".repeat(200), 0).title.length).toBeGreaterThan(200);
  });
});
