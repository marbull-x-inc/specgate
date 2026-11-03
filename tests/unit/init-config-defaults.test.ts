import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { initRepo, packageResolvesFrom } from "../../src/commands/init.ts";
import { loadConfig } from "../../src/config/load.ts";
import { defineConfig, parseConfig } from "../../src/config/schema.ts";
import { workDir } from "../helpers/paths.ts";

describe("init", () => {
  test("writes JSON when the package does not resolve, TS when it does, and --format wins", () => {
    const outside = workDir("init-json");
    expect(packageResolvesFrom(outside)).toBe(false);
    expect(initRepo(outside).written).toContain("specgate.config.json");
    const json: unknown = JSON.parse(readFileSync(join(outside, "specgate.config.json"), "utf8"));
    const config = parseConfig(json);
    expect(config.surface.include).toEqual(["src/**/*.ts"]);
    expect(config.envInputs.forbid).toContain("crypto.randomUUID"); // from the ddd-ts preset by name

    const inside = workDir("init-ts");
    mkdirSync(join(inside, "node_modules", "@marbull-x-inc", "specgate"), { recursive: true });
    writeFileSync(join(inside, "node_modules", "@marbull-x-inc", "specgate", "package.json"), "{}");
    expect(packageResolvesFrom(join(inside, "sub"))).toBe(true);
    expect(initRepo(inside).written).toContain("specgate.config.ts");
    expect(initRepo(workDir("init-forced"), { format: "json" }).written).toContain("specgate.config.json");
  });

  test("the default exclude keeps a single-file library's index.ts", () => {
    const dir = workDir("init-index");
    initRepo(dir, { format: "json", preset: "none" });
    const config = parseConfig(JSON.parse(readFileSync(join(dir, "specgate.config.json"), "utf8")));
    expect(config.surface.exclude.some((g) => g.includes("index.ts"))).toBe(false);
  });

  test("the workflow pins every action by SHA and runs the scoped package", () => {
    const dir = workDir("init-ci");
    initRepo(dir, { ci: true, format: "json" });
    const workflow = readFileSync(join(dir, ".github/workflows/specgate.yml"), "utf8");
    for (const m of workflow.matchAll(/uses:\s*(\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).toContain("bunx @marbull-x-inc/specgate check");
  });
});

describe("config loading", () => {
  test("reports the config files it ignores", async () => {
    const dir = workDir("config-both");
    writeFileSync(join(dir, "specgate.config.ts"), "export default { mode: 'advisory' };\n");
    writeFileSync(join(dir, "specgate.config.json"), '{ "mode": "blocking" }\n');
    const { path, ignored, config } = await loadConfig(dir);
    expect(path?.endsWith("specgate.config.ts")).toBe(true);
    expect(ignored.map((p) => p.split("/").pop())).toEqual(["specgate.config.json"]);
    expect(config.mode).toBe("advisory");
  });

  test("an unknown preset name is an error that lists the built-in ones", () => {
    expect(() => parseConfig({ presets: ["nope"] })).toThrow(/"ddd-ts"/);
  });
});

describe('surface.mode "referenced"', () => {
  test("a test-shaped file outside tests.include does not make an export public", async () => {
    const dir = workDir("referenced");
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" } }),
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test", "legacy"), { recursive: true });
    writeFileSync(
      join(dir, "src", "a.ts"),
      "export function used(): number { return 1; }\nexport function onlyTested(): number { return 2; }\n",
    );
    writeFileSync(join(dir, "src", "main.ts"), 'import { used } from "./a";\nexport const x = used();\n');
    writeFileSync(
      join(dir, "test", "legacy", "a.test.ts"),
      'import { onlyTested } from "../../src/a";\nonlyTested();\n',
    );
    const config = defineConfig({
      root: dir,
      surface: { include: ["src/a.ts"], exclude: [], mode: "referenced" },
      tests: { include: ["tests/**/*.test.ts"] },
    });
    const { report } = await analyze({ ...config, root: dir }, { provenance: false, baseline: null });
    expect(report.units.map((u) => u.id)).toEqual(["used"]);
  });
});
