import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Places the three files a repository needs: `tsdoc.json` extending the shipped tag
 * definitions, a config skeleton, and (optionally) a GitHub Actions workflow that runs `check`
 * and publishes the Step Summary and SARIF.
 *
 * @remarks
 * The config is `specgate.config.ts` when the package resolves from the repository (it imports
 * `defineConfig`), and `specgate.config.json` otherwise: a `.ts` config that imports a package
 * the repository does not have cannot load when specgate is run through `bunx` / `npx`.
 * `format` forces either.
 */
export interface InitOptions {
  ci?: boolean;
  force?: boolean;
  preset?: "ddd-ts" | "none";
  adapter?: "bun" | "vitest" | "jest" | "playwright";
  format?: "ts" | "json";
}

export interface InitResult {
  written: string[];
  skipped: string[];
}

const TSDOC_JSON = `{
  "$schema": "https://developer.microsoft.com/json-schemas/tsdoc/v0/tsdoc.schema.json",
  "extends": ["@marbull-x-inc/specgate/tsdoc.json"]
}
`;

function configTs(options: InitOptions): string {
  const preset = options.preset ?? "ddd-ts";
  const adapter = options.adapter ?? "vitest";
  const presetImport =
    preset === "ddd-ts"
      ? 'import { dddTs, defineConfig } from "@marbull-x-inc/specgate";'
      : 'import { defineConfig } from "@marbull-x-inc/specgate";';
  const presets = preset === "ddd-ts" ? "  presets: [dddTs],\n" : "";
  return `${presetImport}

export default defineConfig({
${presets}  // Files whose exported operations form the public surface (globs, relative to this file).
  surface: { include: ["src/**/*.ts"], exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"] },
  tests: {
    include: ["tests/**/*.test.ts"],
    adapter: "${adapter}",
    // Where gen writes tests: src/a/b.ts -> tests/a/b.test.ts
    mirror: { from: "src", to: "tests", suffix: ".test.ts" },
  },
  // "advisory" never fails CI; switch to "blocking" once the baseline is clean.
  mode: "advisory",
  rules: {},
});
`;
}

function configJson(options: InitOptions): string {
  const preset = options.preset ?? "ddd-ts";
  const config = {
    ...(preset === "ddd-ts" ? { presets: ["ddd-ts"] } : {}),
    surface: { include: ["src/**/*.ts"], exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"] },
    tests: {
      include: ["tests/**/*.test.ts"],
      adapter: options.adapter ?? "vitest",
      mirror: { from: "src", to: "tests", suffix: ".test.ts" },
    },
    mode: "advisory",
    rules: {},
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Whether `@marbull-x-inc/specgate` is installed in `root` or an ancestor's node_modules. */
export function packageResolvesFrom(root: string): boolean {
  let dir = resolve(root);
  for (;;) {
    if (existsSync(join(dir, "node_modules", "@marbull-x-inc", "specgate", "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

const WORKFLOW = `name: specgate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  security-events: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # provenance needs history
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
      - run: bun install --frozen-lockfile
      # The scoped name: a bare "specgate" would fetch an unrelated npm package when not installed.
      - run: bunx @marbull-x-inc/specgate check
      - name: Step summary
        if: always()
        run: cat .specgate/summary.md >> "$GITHUB_STEP_SUMMARY"
      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@9b3254085494b55a0f7c4c2b3d2d52cc712ce370 # v4.39.1
        with:
          sarif_file: .specgate/report.sarif
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        if: always()
        with:
          name: specgate-report
          path: .specgate/report.json
`;

export function initRepo(root: string, options: InitOptions = {}): InitResult {
  const result: InitResult = { written: [], skipped: [] };
  const place = (rel: string, content: string): void => {
    const path = join(root, rel);
    if (existsSync(path) && !options.force) {
      result.skipped.push(rel);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    result.written.push(rel);
  };
  place("tsdoc.json", TSDOC_JSON);
  const format = options.format ?? (packageResolvesFrom(root) ? "ts" : "json");
  if (format === "ts") place("specgate.config.ts", configTs(options));
  else place("specgate.config.json", configJson(options));
  if (options.ci) place(".github/workflows/specgate.yml", WORKFLOW);
  return result;
}
