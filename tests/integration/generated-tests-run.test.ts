import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { EXAMPLE_SHOP, workDir } from "../helpers/paths.ts";

/**
 * The generated files are not just text: with the bun adapter they must load, import
 * `@marbull-x-inc/specgate/runtime`, and behave as designed — doctest and property tests green, the
 * `@throws` skeleton red until a person arranges the input, atomic/idempotent skipped.
 */
describe("generated tests run under bun test", () => {
  test("doctest and property pass, the throws skeleton is red, skeletons are skipped", async () => {
    const repo = join(workDir("bun-run"), "shop");
    cpSync(EXAMPLE_SHOP, repo, { recursive: true });
    writeFileSync(
      join(repo, "specgate.config.ts"),
      `import { defineConfig } from "@marbull-x-inc/specgate";
export default defineConfig({
  surface: { include: ["src/**/*.ts"], exclude: ["src/main.ts"] },
  tests: { include: ["tests/**/*.test.ts"], adapter: "bun", importExtension: ".ts", mirror: { from: "src", to: "tests", suffix: ".test.ts" } },
});
`,
    );
    // Start from no hand-written tests so that every file is generated.
    rmSync(join(repo, "tests"), { recursive: true, force: true });
    expect(await main(["gen", "--cwd", repo])).toBe(0);

    const run = spawnSync("bun", ["test", join(repo, "tests")], { encoding: "utf8", cwd: repo });
    const output = `${run.stdout}\n${run.stderr}`;
    // bun test prints only failures plus a summary: 4 green (2 doctest + 2 property), 1 skipped
    // atomic skeleton, 2 red @throws skeletons, everything else todo.
    expect(output).toMatch(/\n 4 pass\n/);
    expect(output).toMatch(/\n 1 skip\n/);
    expect(output).toMatch(/\n 2 fail\n/);
    expect(output).toMatch(/\(fail\) .*PlaceOrderUseCase#placeOrder\.err\.empty/);
    expect(output).toMatch(/\(fail\) .*addMoney\.err\.currency-mismatch/);
    // The red tests fail on the assertion, not on loading: every module and import resolved.
    expect(output).not.toMatch(/Cannot find (module|package)|SyntaxError|error: Cannot/);
    expect(run.status).toBe(1);
  }, 60_000);
});
