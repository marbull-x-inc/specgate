import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Places the three files a repository needs: `tsdoc.json` extending the shipped tag
 * definitions, a `specgate.config.ts` skeleton, and (optionally) a GitHub Actions workflow
 * that runs `check` and publishes the Step Summary and SARIF.
 */
export interface InitOptions {
  ci?: boolean;
  force?: boolean;
  preset?: "ddd-ts" | "none";
  adapter?: "bun" | "vitest" | "jest" | "playwright";
}

export interface InitResult {
  written: string[];
  skipped: string[];
}

const TSDOC_JSON = `{
  "$schema": "https://developer.microsoft.com/json-schemas/tsdoc/v0/tsdoc.schema.json",
  "extends": ["specgate/tsdoc.json"]
}
`;

function configTs(options: InitOptions): string {
  const preset = options.preset ?? "ddd-ts";
  const adapter = options.adapter ?? "vitest";
  const presetImport =
    preset === "ddd-ts"
      ? 'import { dddTs, defineConfig } from "specgate";'
      : 'import { defineConfig } from "specgate";';
  const presets = preset === "ddd-ts" ? "  presets: [dddTs],\n" : "";
  return `${presetImport}

export default defineConfig({
${presets}  // Files whose exported operations form the public surface (globs, relative to this file).
  surface: { include: ["src/**/*.ts"], exclude: ["**/*.test.ts", "**/index.ts"] },
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
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # provenance needs history
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx specgate check
      - name: Step summary
        if: always()
        run: cat .specgate/summary.md >> "$GITHUB_STEP_SUMMARY"
      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: .specgate/report.sarif
      - uses: actions/upload-artifact@v4
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
  place("specgate.config.ts", configTs(options));
  if (options.ci) place(".github/workflows/specgate.yml", WORKFLOW);
  return result;
}
