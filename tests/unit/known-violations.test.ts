import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { defineConfig } from "../../src/config/schema.ts";
import { generateTests } from "../../src/gen/index.ts";
import { workDir } from "../helpers/paths.ts";

function project(): string {
  const dir = workDir("known");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", types: [] } }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "src", "fmt.ts"),
    `/**
 * @guarantee ok.sign a negative input gives the positive result with a leading "-"
 * @guarantee frame.inputs the options object is not mutated
 */
export function fmt(ms: number, options: { long: boolean }): string {
  return options.long ? String(ms) : String(Math.round(ms));
}
`,
  );
  return dir;
}

function configFor(dir: string, adapter: "bun" | "vitest") {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"], adapter },
  });
  return { ...config, root: dir };
}

describe("expected failures", () => {
  for (const [adapter, call] of [
    ["bun", "test.failing"],
    ["vitest", "test.fails"],
  ] as const) {
    test(`${call} is status "failing" and reported as a known violation`, async () => {
      const dir = project();
      writeFileSync(join(dir, "tests", "fmt.test.ts"), `${call}("fmt.ok.sign -1.5 rounds like 1.5", () => {});\n`);
      const { report } = await analyze(configFor(dir, adapter), { provenance: false, baseline: null });
      expect(report.tests.map((t) => [t.key, t.status])).toEqual([["fmt.ok.sign", "failing"]]);
      const known = report.findings.filter((f) => f.rule === "guarantee-known-violation");
      expect(known.map((f) => [f.test, f.severity])).toEqual([["fmt.ok.sign", "warn"]]);
    });
  }
});

describe("frame for a function without ports", () => {
  test("gen checks that the arguments are not mutated", async () => {
    const dir = project();
    const config = configFor(dir, "bun");
    const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
    const out =
      generateTests(config, extracted, report.vocabulary.entities, { dryRun: true }).written[0]?.content ?? "";
    expect(out).toContain("const before = structuredClone(args);");
    expect(out).toContain("fmt(...args);");
    expect(out).toContain("expect(args).toEqual(before);");
  });
});
