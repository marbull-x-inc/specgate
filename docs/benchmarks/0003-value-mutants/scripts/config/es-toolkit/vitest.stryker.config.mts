// es-toolkit's vitest.config.mts with the two exclusions of the benchmark's test command:
// test files inside node_modules (the config's own `exclude` replaces vitest's default) and
// tests/check-dist.spec.ts (packs the tarball, which needs a Yarn install state).
import { mergeConfig } from "vitest/config";
import base from "./vitest.config.mts";

export default mergeConfig(base, {
  test: { exclude: ["**/node_modules/**", "tests/check-dist.spec.ts"] },
});
