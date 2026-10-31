import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import { dddTs } from "../../src/config/presets/ddd-ts.ts";
import { defineConfig, severityOf } from "../../src/config/schema.ts";
import { workDir } from "../helpers/paths.ts";

describe("defineConfig", () => {
  test("merges presets then the repo config; arrays are replaced, objects merged", () => {
    const config = defineConfig({
      presets: [dddTs],
      surface: { include: ["lib/**/*.ts"] },
      rules: { "test-todo": "off" },
    });
    expect(config.surface.include).toEqual(["lib/**/*.ts"]);
    expect(config.surface.exclude).toEqual(dddTs.surface?.exclude ?? []);
    expect(config.tests.mirror.to).toBe("tests/unit");
    expect(severityOf(config, "env-input-direct")).toBe("warn");
    expect(severityOf(config, "test-todo")).toBe("off");
    expect(severityOf(config, "guarantee-no-test")).toBe("fail");
  });
  test("rejects unknown severities", () => {
    expect(() => defineConfig({ rules: { "test-todo": "loud" as never } })).toThrow();
  });
});

describe("loadConfig", () => {
  test("without a config file every default applies and root is the cwd", async () => {
    const dir = workDir("cfg-none");
    const { config, path } = await loadConfig(dir);
    expect(path).toBeUndefined();
    expect(config.root).toBe(dir);
    expect(config.mode).toBe("advisory");
  });
  test("reads specgate.config.json", async () => {
    const dir = workDir("cfg-json");
    writeFileSync(join(dir, "specgate.config.json"), JSON.stringify({ mode: "blocking", tests: { adapter: "jest" } }));
    const { config, path } = await loadConfig(dir);
    expect(path).toBe(join(dir, "specgate.config.json"));
    expect(config.mode).toBe("blocking");
    expect(config.tests.adapter).toBe("jest");
  });
  test("reads a TypeScript config that default-exports defineConfig(...)", async () => {
    const dir = workDir("cfg-ts");
    writeFileSync(
      join(dir, "specgate.config.ts"),
      `import { defineConfig } from "@marbull-x-inc/specgate";\nexport default defineConfig({ ids: { pattern: "^G[1-9]\\\\d*$" } });\n`,
    );
    const { config } = await loadConfig(dir);
    expect(config.ids.pattern).toBe("^G[1-9]\\d*$");
  });
  test("an explicit path that does not export an object is an error", async () => {
    const dir = workDir("cfg-bad");
    writeFileSync(join(dir, "weird.config.mjs"), "export default 42;\n");
    await expect(loadConfig(dir, "weird.config.mjs")).rejects.toThrow(/must export a config object/);
  });
});
