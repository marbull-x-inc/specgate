import { z } from "zod";

/**
 * Configuration accepted from `specgate.config.ts`.
 *
 * @remarks
 * The core knows nothing about a particular repository: layer names, directories, id
 * vocabulary, test-title prefixes and rule severities all come from here. Presets are
 * partial configs merged before the repo's own values, so a repo normally writes
 * `defineConfig({ presets: [dddTs], surface: { include: [...] } })` and little else.
 */
export const zRuleSeverity = z.enum(["fail", "warn", "info", "off"]);
export type RuleSeverity = z.infer<typeof zRuleSeverity>;

export const zTestAdapter = z.enum(["bun", "vitest", "jest", "playwright"]);
export type TestAdapter = z.infer<typeof zTestAdapter>;

export const zConfig = z.object({
  root: z.string().default("."),
  tsconfig: z.string().default("tsconfig.json"),
  surface: z
    .object({
      include: z.array(z.string()).default(["src/**/*.ts"]),
      exclude: z.array(z.string()).default(["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"]),
      mode: z.enum(["referenced", "exported"]).default("referenced"),
      /** Pattern for class names whose public methods are operations. Default: every exported class. */
      classPattern: z.string().optional(),
    })
    .prefault({}),
  tests: z
    .object({
      include: z.array(z.string()).default(["tests/**/*.test.ts", "**/*.test.ts", "**/*.spec.ts"]),
      adapter: zTestAdapter.default("vitest"),
      mirror: z
        .object({
          from: z.string().default("src"),
          to: z.string().default("tests"),
          suffix: z.string().default(".test.ts"),
        })
        .prefault({}),
      /** describe() titles that name the operation; the first capture group is the operation name. */
      describeOperationPatterns: z.array(z.string()).default(["^method (\\w+)\\(\\)$", "^(\\w+)\\(\\)$", "^(\\w+)$"]),
      /** Title prefix per guarantee kind inserted by gen, e.g. { ok: "正常系:" }. Empty by default. */
      prefixes: z.record(z.string(), z.string()).prefault({}),
      /** Extension gen writes on relative imports: "" (bundler style), ".ts" (bun / allowImportingTsExtensions) or ".js" (NodeNext). */
      importExtension: z.enum(["", ".ts", ".js"]).default(""),
      /** Files gen fully owns; they are regenerated each run and not linked to guarantees. */
      generatedSuffixes: z.array(z.string()).default([".doctest.test.ts", ".property.test.ts"]),
    })
    .prefault({}),
  ids: z
    .object({
      pattern: z.string().default("^(ok|err|atomic|frame|idempotent)(\\.[a-z0-9]+(?:-[a-z0-9]+)*)*$"),
      placeholder: z.string().default("TODO"),
    })
    .prefault({}),
  rules: z.record(z.string(), zRuleSeverity).prefault({}),
  mode: z.enum(["advisory", "blocking"]).default("advisory"),
  output: z
    .object({
      dir: z.string().default(".specgate"),
      docsDir: z.string().default("docs/spec"),
      baseline: z.string().optional(),
    })
    .prefault({}),
  provenance: z
    .object({
      enabled: z.boolean().default(true),
      prPattern: z.string().default("\\(#(\\d+)\\)\\s*$"),
    })
    .prefault({}),
  requirementHeader: z
    .object({
      enabled: z.boolean().default(false),
      pattern: z.string().default("^\\s*(?:\\*|//)\\s*@requirement\\s+(\\S+)"),
    })
    .prefault({}),
  envInputs: z
    .object({
      forbid: z.array(z.string()).default(["Date.now", "new Date", "Math.random", "fetch", "process.env"]),
      /** Files where direct environment inputs are reported. Default: the surface files. */
      include: z.array(z.string()).optional(),
    })
    .prefault({}),
  resolve: z
    .object({
      /** Tokens never reported as unresolved. */
      ignore: z.array(z.string()).default([]),
      /** Accept PascalCase tokens that name any exported type, class or enum in the program. */
      allowProgramTypes: z.boolean().default(true),
    })
    .prefault({}),
});

export type Config = z.infer<typeof zConfig>;
export type ConfigInput = z.input<typeof zConfig>;

/** A preset is a partial config; later entries and the repo config override earlier ones. */
export type Preset = ConfigInput & { name: string };

export type DefineConfigInput = ConfigInput & { presets?: Preset[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * Merges presets and the repo config, then validates. Arrays are replaced, objects merged.
 * @throws ZodError when the merged value violates the schema.
 */
export function defineConfig(input: DefineConfigInput): Config {
  const { presets = [], ...own } = input;
  let merged: Record<string, unknown> = {};
  for (const preset of presets) {
    const { name: _name, ...rest } = preset;
    merged = deepMerge(merged, rest);
  }
  merged = deepMerge(merged, own);
  return zConfig.parse(merged);
}

export const RULE_IDS = [
  "tsdoc-syntax",
  "operation-no-guarantee",
  "guarantee-placeholder",
  "guarantee-id-invalid",
  "guarantee-id-duplicate",
  "guarantee-no-test",
  "test-orphan",
  "test-todo",
  "identifier-unresolved",
  "guarantee-changed-test-unchanged",
  "impl-changed-spec-unchanged",
  "operation-removed",
  "uses-mismatch",
  "env-input-direct",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const DEFAULT_SEVERITIES: Record<RuleId, RuleSeverity> = {
  "tsdoc-syntax": "fail",
  "operation-no-guarantee": "fail",
  "guarantee-placeholder": "fail",
  "guarantee-id-invalid": "fail",
  "guarantee-id-duplicate": "fail",
  "guarantee-no-test": "fail",
  "test-orphan": "fail",
  "test-todo": "warn",
  "identifier-unresolved": "fail",
  "guarantee-changed-test-unchanged": "warn",
  "impl-changed-spec-unchanged": "warn",
  "operation-removed": "fail",
  "uses-mismatch": "warn",
  "env-input-direct": "warn",
};

export function severityOf(config: Config, rule: RuleId): RuleSeverity {
  return config.rules[rule] ?? DEFAULT_SEVERITIES[rule];
}
