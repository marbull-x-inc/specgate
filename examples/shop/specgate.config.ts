import { defineConfig } from "specgate";

export default defineConfig({
  surface: { include: ["src/**/*.ts"], exclude: ["src/main.ts"] },
  tests: { include: ["tests/**/*.test.ts"], adapter: "jest", mirror: { from: "src", to: "tests", suffix: ".test.ts" } },
  envInputs: { forbid: ["Date.now", "new Date", "Math.random"] },
});
