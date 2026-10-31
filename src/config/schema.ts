/**
 * Configuration accepted from `specgate.config.ts`.
 *
 * @remarks
 * The core knows nothing about a particular repository: layer names, directories, id
 * vocabulary, test-title prefixes and rule severities all come from here. Presets are
 * partial configs merged before the repo's own values, so a repo normally writes
 * `defineConfig({ presets: [dddTs], surface: { include: [...] } })` and little else.
 * Validation is hand-written so that the published package has no runtime dependency
 * beyond the TypeScript compiler and the TSDoc parser.
 */
export const RULE_SEVERITIES = ["fail", "warn", "info", "off"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const TEST_ADAPTERS = ["bun", "vitest", "jest", "playwright"] as const;
export type TestAdapter = (typeof TEST_ADAPTERS)[number];

export const IMPORT_EXTENSIONS = ["", ".ts", ".js"] as const;
export type ImportExtension = (typeof IMPORT_EXTENSIONS)[number];

export interface Config {
  root: string;
  tsconfig: string;
  surface: {
    include: string[];
    exclude: string[];
    mode: "referenced" | "exported";
    /** Pattern for class names whose public methods are operations. Unset: every exported class. */
    classPattern?: string;
  };
  tests: {
    include: string[];
    adapter: TestAdapter;
    mirror: { from: string; to: string; suffix: string };
    /** describe() titles that name the operation; the first capture group is the operation name. */
    describeOperationPatterns: string[];
    /** Title prefix per guarantee kind inserted by gen, e.g. { ok: "正常系:" }. */
    prefixes: Record<string, string>;
    /** Extension gen writes on relative imports: "" (bundler), ".ts" (bun) or ".js" (NodeNext). */
    importExtension: ImportExtension;
    /** Files gen fully owns; regenerated each run and never linked to guarantees. */
    generatedSuffixes: string[];
  };
  ids: { pattern: string; placeholder: string };
  rules: Record<string, RuleSeverity>;
  mode: "advisory" | "blocking";
  output: { dir: string; docsDir: string; baseline?: string };
  provenance: { enabled: boolean; prPattern: string };
  requirementHeader: { enabled: boolean; pattern: string };
  envInputs: { forbid: string[]; include?: string[] };
  resolve: { ignore: string[]; allowProgramTypes: boolean };
}

/** What a config file or preset may write: every field optional, nested objects partial. */
export interface ConfigInput {
  root?: string;
  tsconfig?: string;
  surface?: Partial<Config["surface"]>;
  tests?: Partial<Omit<Config["tests"], "mirror">> & { mirror?: Partial<Config["tests"]["mirror"]> };
  ids?: Partial<Config["ids"]>;
  rules?: Record<string, RuleSeverity>;
  mode?: Config["mode"];
  output?: Partial<Config["output"]>;
  provenance?: Partial<Config["provenance"]>;
  requirementHeader?: Partial<Config["requirementHeader"]>;
  envInputs?: Partial<Config["envInputs"]>;
  resolve?: Partial<Config["resolve"]>;
}

/** A preset is a partial config; later entries and the repo config override earlier ones. */
export type Preset = ConfigInput & { name: string };

export type DefineConfigInput = ConfigInput & { presets?: Preset[] };

export function defaultConfig(): Config {
  return {
    root: ".",
    tsconfig: "tsconfig.json",
    surface: {
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"],
      mode: "referenced",
    },
    tests: {
      include: ["tests/**/*.test.ts", "**/*.test.ts", "**/*.spec.ts"],
      adapter: "vitest",
      mirror: { from: "src", to: "tests", suffix: ".test.ts" },
      describeOperationPatterns: ["^method (\\w+)\\(\\)$", "^(\\w+)\\(\\)$", "^(\\w+)$"],
      prefixes: {},
      importExtension: "",
      generatedSuffixes: [".doctest.test.ts", ".property.test.ts"],
    },
    ids: {
      pattern: "^(ok|err|atomic|frame|idempotent)(\\.[a-z0-9]+(?:-[a-z0-9]+)*)*$",
      placeholder: "TODO",
    },
    rules: {},
    mode: "advisory",
    output: { dir: ".specgate", docsDir: "docs/spec" },
    provenance: { enabled: true, prPattern: "\\(#(\\d+)\\)\\s*$" },
    requirementHeader: { enabled: false, pattern: "^\\s*(?:\\*|//)\\s*@requirement\\s+(\\S+)" },
    envInputs: { forbid: ["Date.now", "new Date", "Math.random", "fetch", "process.env"] },
    resolve: { ignore: [], allowProgramTypes: true },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ConfigError extends Error {
  constructor(path: string, expected: string, actual: unknown) {
    super(`specgate config: ${path} must be ${expected}, got ${JSON.stringify(actual)}`);
  }
}

/** Reads fields of one object, validating their shape; absent fields keep the current value. */
class Reader {
  constructor(
    private readonly source: Record<string, unknown>,
    private readonly path: string,
  ) {}
  private at(key: string): string {
    return this.path ? `${this.path}.${key}` : key;
  }
  string(key: string, apply: (v: string) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    if (typeof v !== "string") throw new ConfigError(this.at(key), "a string", v);
    apply(v);
  }
  boolean(key: string, apply: (v: boolean) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    if (typeof v !== "boolean") throw new ConfigError(this.at(key), "a boolean", v);
    apply(v);
  }
  strings(key: string, apply: (v: string[]) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
      throw new ConfigError(this.at(key), "an array of strings", v);
    }
    apply([...v]);
  }
  oneOf<T extends string>(key: string, allowed: readonly T[], apply: (v: T) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    const hit = allowed.find((a) => a === v);
    if (hit === undefined) {
      throw new ConfigError(this.at(key), `one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`, v);
    }
    apply(hit);
  }
  stringRecord(key: string, apply: (v: Record<string, string>) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    if (!isRecord(v)) throw new ConfigError(this.at(key), "an object of strings", v);
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x !== "string") throw new ConfigError(`${this.at(key)}.${k}`, "a string", x);
      out[k] = x;
    }
    apply(out);
  }
  object(key: string, apply: (reader: Reader) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    if (!isRecord(v)) throw new ConfigError(this.at(key), "an object", v);
    apply(new Reader(v, this.at(key)));
  }
}

/** Applies one partial config (a preset or the repo's own) on top of `config`, validating as it goes. */
function applyInput(config: Config, input: unknown, label: string): void {
  if (!isRecord(input)) throw new ConfigError(label, "an object", input);
  const r = new Reader(input, "");
  r.string("root", (v) => {
    config.root = v;
  });
  r.string("tsconfig", (v) => {
    config.tsconfig = v;
  });
  r.oneOf("mode", ["advisory", "blocking"] as const, (v) => {
    config.mode = v;
  });
  r.object("surface", (s) => {
    s.strings("include", (v) => {
      config.surface.include = v;
    });
    s.strings("exclude", (v) => {
      config.surface.exclude = v;
    });
    s.oneOf("mode", ["referenced", "exported"] as const, (v) => {
      config.surface.mode = v;
    });
    s.string("classPattern", (v) => {
      config.surface.classPattern = v;
    });
  });
  r.object("tests", (t) => {
    t.strings("include", (v) => {
      config.tests.include = v;
    });
    t.oneOf("adapter", TEST_ADAPTERS, (v) => {
      config.tests.adapter = v;
    });
    t.object("mirror", (m) => {
      m.string("from", (v) => {
        config.tests.mirror.from = v;
      });
      m.string("to", (v) => {
        config.tests.mirror.to = v;
      });
      m.string("suffix", (v) => {
        config.tests.mirror.suffix = v;
      });
    });
    t.strings("describeOperationPatterns", (v) => {
      config.tests.describeOperationPatterns = v;
    });
    t.stringRecord("prefixes", (v) => {
      config.tests.prefixes = v;
    });
    t.oneOf("importExtension", IMPORT_EXTENSIONS, (v) => {
      config.tests.importExtension = v;
    });
    t.strings("generatedSuffixes", (v) => {
      config.tests.generatedSuffixes = v;
    });
  });
  r.object("ids", (i) => {
    i.string("pattern", (v) => {
      config.ids.pattern = v;
    });
    i.string("placeholder", (v) => {
      config.ids.placeholder = v;
    });
  });
  const rules = input["rules"];
  if (rules !== undefined) {
    if (!isRecord(rules)) throw new ConfigError("rules", "an object", rules);
    for (const [rule, severity] of Object.entries(rules)) {
      const hit = RULE_SEVERITIES.find((s) => s === severity);
      if (hit === undefined) throw new ConfigError(`rules.${rule}`, `one of ${RULE_SEVERITIES.join(", ")}`, severity);
      config.rules[rule] = hit;
    }
  }
  r.object("output", (o) => {
    o.string("dir", (v) => {
      config.output.dir = v;
    });
    o.string("docsDir", (v) => {
      config.output.docsDir = v;
    });
    o.string("baseline", (v) => {
      config.output.baseline = v;
    });
  });
  r.object("provenance", (p) => {
    p.boolean("enabled", (v) => {
      config.provenance.enabled = v;
    });
    p.string("prPattern", (v) => {
      config.provenance.prPattern = v;
    });
  });
  r.object("requirementHeader", (h) => {
    h.boolean("enabled", (v) => {
      config.requirementHeader.enabled = v;
    });
    h.string("pattern", (v) => {
      config.requirementHeader.pattern = v;
    });
  });
  r.object("envInputs", (e) => {
    e.strings("forbid", (v) => {
      config.envInputs.forbid = v;
    });
    e.strings("include", (v) => {
      config.envInputs.include = v;
    });
  });
  r.object("resolve", (x) => {
    x.strings("ignore", (v) => {
      config.resolve.ignore = v;
    });
    x.boolean("allowProgramTypes", (v) => {
      config.resolve.allowProgramTypes = v;
    });
  });
  // Patterns must compile; failing here is clearer than failing inside a rule.
  new RegExp(config.ids.pattern);
  new RegExp(config.provenance.prPattern);
  new RegExp(config.requirementHeader.pattern);
}

/**
 * Validates an untyped value (for example a parsed JSON file) into a complete config.
 * Presets listed under `presets` apply first, in order; the value's own fields apply last.
 * @throws Error naming the offending path when a field has the wrong shape.
 */
export function parseConfig(input: unknown): Config {
  const config = defaultConfig();
  if (input === undefined) return config;
  if (!isRecord(input)) throw new ConfigError("config", "an object", input);
  const { presets, ...own } = input;
  if (presets !== undefined) {
    if (!Array.isArray(presets)) throw new ConfigError("presets", "an array of presets", presets);
    presets.forEach((preset, index) => {
      if (!isRecord(preset)) throw new ConfigError(`presets[${index}]`, "a preset object", preset);
      const { name: _name, ...rest } = preset;
      applyInput(config, rest, `presets[${index}]`);
    });
  }
  applyInput(config, own, "config");
  return config;
}

/**
 * Merges presets and the repo config, then validates. Arrays are replaced, objects merged.
 * @throws Error when the merged value violates the expected shape.
 */
export function defineConfig(input: DefineConfigInput): Config {
  return parseConfig(input);
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
