import { dddTs } from "./presets/ddd-ts.ts";

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
    /** Pattern for operation names (methods and functions) to include. Unset: every operation. */
    operationPattern?: string;
    /** `package.json#exports` subpath → source module, for entries whose targets are build output only. */
    entries: Record<string, string>;
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
    /** gen wraps a generated `test.todo` line that would exceed this many characters. */
    lineWidth: number;
    /**
     * Quote style of generated string literals. `"auto"` reads the formatter config in `root`
     * (Biome `javascript.formatter.quoteStyle`, Prettier `singleQuote`) and falls back to double.
     */
    quote: "auto" | "double" | "single";
    /**
     * Longest generated test title. The key is always kept whole; the statement is cut at a word
     * boundary with "…", and the full statement goes in a comment above the test. 0 never cuts.
     */
    titleLength: number;
    /** More title prefixes to strip before reading the key (matching only; gen never writes them). */
    titlePrefixes: string[];
    /**
     * Prefix rules for gen, tried in order before `prefixes[kind]`: the first whose `id` regular
     * expression matches the guarantee id (and `throws`, if given, the error type) gives the prefix.
     */
    prefixRules: Array<{ id: string; throws?: string; prefix: string }>;
    /**
     * How gen obtains the unit and its ports, for projects whose tests take them from a container.
     * `sut` replaces `new Target(ports…)`, `port` replaces the stub for every injected port;
     * placeholders `{Target}`, `{operation}`, `{Port}`, `{member}`. `imports` are added as written.
     */
    arrange?: { sut?: string; port?: string; imports?: string[] };
    /** Most literal values recorded per test (`TestCase.literals`). */
    literalLimit: number;
  };
  /** `deriveThrows`: give `@throws` without an id one (`err.<error-type>`); see surface extraction. */
  ids: { pattern: string; placeholder: string; deriveThrows: boolean };
  /** `jsdoc`: accept JSDoc conventions (unknown block tags, `{type}` in `@param`, `{` in prose) silently. */
  tsdoc: { jsdoc: boolean };
  rules: Record<string, RuleSeverity>;
  mode: "advisory" | "blocking";
  /** `accepted`: committed file of findings accepted at adoption, relative to root. */
  output: { dir: string; docsDir: string; baseline?: string; accepted: string };
  provenance: { enabled: boolean; prPattern: string };
  requirementHeader: { enabled: boolean; pattern: string };
  envInputs: { forbid: string[]; include?: string[] };
  /**
   * `ignore`: values or constant names `decision-unspecified` treats as named by the contract and
   * `decision-untested` does not ask the tests for. `collectionLimit`: most `member` decisions
   * recorded per collection; the rest are reported once by `decision-collection-truncated`.
   */
  decisions: { ignore: string[]; collectionLimit: number };
  /**
   * `report`: a mutation-testing-report-schema JSON (Stryker's `mutation.json`) another tool
   * wrote, relative to root; unset turns the mutation rules off. `detected`: mutant statuses that
   * count as caught by the tests. `findings`: one `mutant-survived` per mutant, or one per unit
   * listing up to `listLimit` survivors. `exclude`: unit ids or file globs whose mutants are
   * counted but give no findings (code tested outside this config).
   */
  mutation: {
    report?: string;
    detected: string[];
    findings: "mutant" | "unit";
    listLimit: number;
    exclude: string[];
  };
  resolve: { ignore: string[]; allowProgramTypes: boolean };
}

/** What a config file or preset may write: every field optional, nested objects partial. */
export interface ConfigInput {
  root?: string;
  tsconfig?: string;
  surface?: Partial<Config["surface"]>;
  tests?: Partial<Omit<Config["tests"], "mirror">> & { mirror?: Partial<Config["tests"]["mirror"]> };
  ids?: Partial<Config["ids"]>;
  tsdoc?: Partial<Config["tsdoc"]>;
  rules?: Record<string, RuleSeverity>;
  mode?: Config["mode"];
  output?: Partial<Config["output"]>;
  provenance?: Partial<Config["provenance"]>;
  requirementHeader?: Partial<Config["requirementHeader"]>;
  envInputs?: Partial<Config["envInputs"]>;
  decisions?: Partial<Config["decisions"]>;
  mutation?: Partial<Config["mutation"]>;
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
      entries: {},
    },
    tests: {
      include: ["tests/**/*.test.ts", "**/*.test.ts", "**/*.spec.ts"],
      adapter: "vitest",
      mirror: { from: "src", to: "tests", suffix: ".test.ts" },
      describeOperationPatterns: ["^method (\\w+)\\(\\)$", "^(\\w+)\\(\\)$", "^(\\w+)$"],
      prefixes: {},
      importExtension: "",
      generatedSuffixes: [".doctest.test.ts", ".property.test.ts"],
      lineWidth: 120,
      quote: "auto",
      titleLength: 100,
      titlePrefixes: [],
      prefixRules: [],
      literalLimit: 1000,
    },
    ids: {
      pattern: "^(ok|err|atomic|frame|idempotent)(\\.[a-z0-9]+(?:-[a-z0-9]+)*)*$",
      placeholder: "TODO",
      deriveThrows: true,
    },
    tsdoc: { jsdoc: false },
    rules: {},
    mode: "advisory",
    output: { dir: ".specgate", docsDir: "docs/spec", accepted: "specgate.accepted.json" },
    provenance: { enabled: true, prPattern: "\\(#(\\d+)\\)\\s*$" },
    requirementHeader: { enabled: false, pattern: "^\\s*(?:\\*|//)\\s*@requirement\\s+(\\S+)" },
    envInputs: { forbid: ["Date.now", "new Date", "Math.random", "fetch", "process.env"] },
    decisions: { ignore: [], collectionLimit: 500 },
    mutation: {
      detected: ["Killed", "Timeout", "RuntimeError", "CompileError"],
      findings: "mutant",
      listLimit: 5,
      exclude: [],
    },
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
  number(key: string, apply: (v: number) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(this.at(key), "a number", v);
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
  /** An array of objects, each mapped (and validated) by `map`. */
  records<T>(key: string, map: (value: Record<string, unknown>, path: string) => T, apply: (v: T[]) => void): void {
    const v = this.source[key];
    if (v === undefined) return;
    if (!Array.isArray(v)) throw new ConfigError(this.at(key), "an array of objects", v);
    apply(
      v.map((item: unknown, i) => {
        const path = `${this.at(key)}[${i}]`;
        if (!isRecord(item)) throw new ConfigError(path, "an object", item);
        return map(item, path);
      }),
    );
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
    s.string("operationPattern", (v) => {
      config.surface.operationPattern = v;
    });
    s.stringRecord("entries", (v) => {
      config.surface.entries = v;
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
    t.number("lineWidth", (v) => {
      config.tests.lineWidth = v;
    });
    t.oneOf("quote", ["auto", "double", "single"] as const, (v) => {
      config.tests.quote = v;
    });
    t.number("titleLength", (v) => {
      config.tests.titleLength = v;
    });
    t.number("literalLimit", (v) => {
      config.tests.literalLimit = v;
    });
    t.strings("titlePrefixes", (v) => {
      config.tests.titlePrefixes = v;
    });
    t.records(
      "prefixRules",
      (rule, path) => {
        const id = rule["id"];
        const throws = rule["throws"];
        const prefix = rule["prefix"];
        if (typeof id !== "string") throw new ConfigError(`${path}.id`, "a regular expression string", id);
        if (throws !== undefined && typeof throws !== "string")
          throw new ConfigError(`${path}.throws`, "a regular expression string", throws);
        if (typeof prefix !== "string") throw new ConfigError(`${path}.prefix`, "a string", prefix);
        new RegExp(id);
        if (throws !== undefined) new RegExp(throws);
        return { id, prefix, ...(throws !== undefined ? { throws } : {}) };
      },
      (v) => {
        config.tests.prefixRules = v;
      },
    );
    t.object("arrange", (a) => {
      const arrange: NonNullable<Config["tests"]["arrange"]> = { ...config.tests.arrange };
      a.string("sut", (v) => {
        arrange.sut = v;
      });
      a.string("port", (v) => {
        arrange.port = v;
      });
      a.strings("imports", (v) => {
        arrange.imports = v;
      });
      config.tests.arrange = arrange;
    });
  });
  r.object("ids", (i) => {
    i.string("pattern", (v) => {
      config.ids.pattern = v;
    });
    i.string("placeholder", (v) => {
      config.ids.placeholder = v;
    });
    i.boolean("deriveThrows", (v) => {
      config.ids.deriveThrows = v;
    });
  });
  r.object("tsdoc", (t) => {
    t.boolean("jsdoc", (v) => {
      config.tsdoc.jsdoc = v;
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
    o.string("accepted", (v) => {
      config.output.accepted = v;
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
  r.object("decisions", (d) => {
    d.strings("ignore", (v) => {
      config.decisions.ignore = v;
    });
    d.number("collectionLimit", (v) => {
      config.decisions.collectionLimit = v;
    });
  });
  r.object("mutation", (m) => {
    m.string("report", (v) => {
      config.mutation.report = v;
    });
    m.strings("detected", (v) => {
      config.mutation.detected = v;
    });
    m.oneOf("findings", ["mutant", "unit"] as const, (v) => {
      config.mutation.findings = v;
    });
    m.number("listLimit", (v) => {
      config.mutation.listLimit = v;
    });
    m.strings("exclude", (v) => {
      config.mutation.exclude = v;
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
  if (config.surface.classPattern !== undefined) new RegExp(config.surface.classPattern);
  if (config.surface.operationPattern !== undefined) new RegExp(config.surface.operationPattern);
  new RegExp(config.provenance.prPattern);
  new RegExp(config.requirementHeader.pattern);
}

/**
 * Validates an untyped value (for example a parsed JSON file) into a complete config.
 * Presets listed under `presets` apply first, in order; the value's own fields apply last. A
 * preset is an object or, so that JSON configs can use them, the name of a built-in preset
 * (`"ddd-ts"`).
 * @throws Error naming the offending path when a field has the wrong shape.
 */
export function parseConfig(input: unknown): Config {
  const config = defaultConfig();
  if (input === undefined) return config;
  if (!isRecord(input)) throw new ConfigError("config", "an object", input);
  const { presets, ...own } = input;
  if (presets !== undefined) {
    if (!Array.isArray(presets)) throw new ConfigError("presets", "an array of presets", presets);
    presets.forEach((entry, index) => {
      const preset = typeof entry === "string" ? BUILTIN_PRESETS[entry] : entry;
      if (!isRecord(preset))
        throw new ConfigError(
          `presets[${index}]`,
          `a preset object or one of ${Object.keys(BUILTIN_PRESETS)
            .map((n) => JSON.stringify(n))
            .join(", ")}`,
          entry,
        );
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

const BUILTIN_PRESETS: Readonly<Record<string, Preset>> = { "ddd-ts": dddTs };

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
  "decision-unspecified",
  "guarantee-on-non-unit",
  "surface-empty",
  "guarantee-known-violation",
  "entry-unmapped",
  "decision-untested",
  "test-tautology",
  "decision-collection-truncated",
  "mutant-survived",
  "unit-not-executed",
  "mutation-report-unreadable",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const DEFAULT_SEVERITIES: Record<RuleId, RuleSeverity> = {
  "tsdoc-syntax": "warn",
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
  "decision-unspecified": "warn",
  "guarantee-on-non-unit": "fail",
  "surface-empty": "warn",
  "guarantee-known-violation": "warn",
  "entry-unmapped": "info",
  "decision-untested": "warn",
  "test-tautology": "warn",
  "decision-collection-truncated": "info",
  "mutant-survived": "warn",
  "unit-not-executed": "warn",
  "mutation-report-unreadable": "warn",
};

export function severityOf(config: Config, rule: RuleId): RuleSeverity {
  return config.rules[rule] ?? DEFAULT_SEVERITIES[rule];
}
