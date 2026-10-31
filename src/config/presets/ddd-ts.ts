import type { Preset } from "../schema.ts";

/**
 * Preset for a TypeScript codebase laid out in DDD layers.
 *
 * @remarks
 * Application and domain modules carry the specification units; infrastructure, interface
 * (HTTP / CLI) and generated code are excluded because they map onto other layers instead
 * of promising behaviour of their own. Ports are interfaces marked `@port`; environment
 * inputs (clock, randomness, network) must reach application and domain code only through
 * them, so their direct use is reported there.
 */
export const dddTs: Preset = {
  name: "ddd-ts",
  surface: {
    include: [
      "src/application/**/*.ts",
      "src/domain/**/*.ts",
      "packages/application/src/**/*.ts",
      "packages/domain/src/**/*.ts",
    ],
    exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts", "**/index.ts", "**/*.generated.ts", "**/dtos/**"],
    mode: "referenced",
  },
  tests: {
    include: ["tests/**/*.test.ts", "test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    mirror: { from: "src", to: "tests/unit", suffix: ".test.ts" },
  },
  envInputs: {
    forbid: ["Date.now", "new Date", "Math.random", "fetch", "process.env", "crypto.randomUUID"],
  },
  rules: {
    "env-input-direct": "warn",
    "uses-mismatch": "warn",
  },
};
