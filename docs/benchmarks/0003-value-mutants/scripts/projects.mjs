// Per-project settings of benchmark 0003, and a generator for the configs in config/<project>/.
//
//   node projects.mjs            writes config/<project>/{stryker,specgate,specgate.mutation}.json
//
// `cwd` is where Stryker and the test command run, relative to the project root. `test` is the
// test command Stryker drives (protocol, Runs); the runner appends the selected test files.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bench = dirname(here);

export const PROJECTS = {
  "es-toolkit": {
    runner: "vitest",
    cwd: ".",
    test: "npx vitest run --exclude '**/node_modules/**' --exclude tests/check-dist.spec.ts",
    tests: ["src/**/*.spec.ts"],
    vitestConfig: "vitest.stryker.config.mts",
  },
  defu: { runner: "vitest", cwd: ".", test: "npx vitest run", tests: ["test/**/*.test.ts"] },
  valibot: {
    runner: "vitest",
    cwd: "library",
    test: "npx vitest run",
    tests: ["library/src/**/*.test.ts"],
    tsconfig: "library/tsconfig.json",
  },
  "cron-parser": { runner: "jest", cwd: ".", test: "TZ=UTC npx jest --watchman=false", tests: ["tests/**/*.test.ts"], env: { TZ: "UTC" } },
  neverthrow: { runner: "vitest", cwd: ".", test: "npx vitest run", tests: ["tests/**/*.test.ts"] },
  jotai: { runner: "vitest", cwd: ".", test: "npx vitest run", tests: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
  "react-hook-form": {
    runner: "jest",
    cwd: ".",
    test: "TEST_ENV=web npx jest --config ./scripts/jest/jest.config.js --watchman=false",
    tests: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    jestConfig: "jest.stryker.config.js",
  },
  "react-hotkeys-hook": {
    runner: "vitest",
    cwd: "packages/react-hotkeys-hook",
    test: "npx vitest run",
    tests: ["packages/react-hotkeys-hook/src/test/**/*.test.ts", "packages/react-hotkeys-hook/src/test/**/*.test.tsx"],
    tsconfig: "packages/react-hotkeys-hook/tsconfig.app.json",
  },
  "express-rate-limit": {
    runner: "jest",
    cwd: ".",
    test: "npx jest --watchman=false --testPathIgnorePatterns /node_modules/ /.stryker-tmp/ types-test",
    tests: ["test/library/**/*-test.ts"],
    jestConfig: "jest.config.json",
    // Not "/.stryker-tmp/": Stryker's own sandbox is inside it.
    jestExtra: { testPathIgnorePatterns: ["/node_modules/", "types-test"] },
  },
  cac: { runner: "vitest", cwd: ".", test: "npx vitest run", tests: ["tests/**/*.test.ts"] },
};

function configs(name, p) {
  const scope = JSON.parse(readFileSync(join(bench, "data", name, "scope.json"), "utf8"));
  const mutate = scope.files.map((f) => relative(p.cwd, f));
  const stryker = {
    $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    testRunner: p.runner,
    coverageAnalysis: "perTest",
    mutate,
    reporters: ["json"],
    jsonReporter: { fileName: "reports/mutation/mutation.json" },
    tempDirName: ".stryker-tmp",
    plugins: [`@stryker-mutator/${p.runner}-runner`],
    ...(p.vitestConfig ? { vitest: { configFile: p.vitestConfig } } : {}),
    ...(p.runner === "jest"
      ? { jest: { ...(p.jestConfig ? { configFile: p.jestConfig } : {}), config: { watchman: false, ...(p.jestExtra ?? {}) } } }
      : {}),
  };
  const specgate = (out, report) => ({
    surface: { include: scope.files, mode: "exported" },
    tests: { include: p.tests, adapter: p.runner },
    ...(p.tsconfig ? { tsconfig: p.tsconfig } : {}),
    tsdoc: { jsdoc: true },
    provenance: { enabled: false },
    output: { dir: out },
    ...(report ? { mutation: { report } } : {}),
  });
  const strykerReport = join(p.cwd, "reports/mutation/mutation.json").replace(/\\/g, "/");
  return {
    "stryker.config.json": stryker,
    "specgate.config.json": specgate(".specgate-static"),
    "specgate.mutation.config.json": specgate(".specgate-mutation", [strykerReport, "reports/value/value.json"]),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, p] of Object.entries(PROJECTS)) {
    const dir = join(here, "config", name);
    mkdirSync(dir, { recursive: true });
    for (const [file, value] of Object.entries(configs(name, p)))
      writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
    process.stdout.write(`config/${name}\n`);
  }
}
