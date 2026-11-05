import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  commandFor,
  mutatedText,
  runValueMutants,
  type StrykerCoverage,
  selectTests,
  toReport,
  type ValueMutant,
} from "../../scripts/value-mutants/run.ts";
import { analyze, TOOL } from "../../src/analyze.ts";
import { main } from "../../src/cli.ts";
import { type ConfigInput, defineConfig, parseConfig } from "../../src/config/schema.ts";
import { listValueMutants, type ValueMutantList } from "../../src/mutants/index.ts";
import { workDir } from "../helpers/paths.ts";

function project(files: Record<string, string>): string {
  const dir = workDir("value-mutants");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function configOf(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
    ...overrides,
  });
  return { ...config, root: dir };
}

async function mutantsOf(dir: string): Promise<ValueMutantList> {
  const config = configOf(dir);
  const { report, host } = await analyze(config, { provenance: false, baseline: null });
  return listValueMutants(report.units, host, dir, TOOL);
}

/** The fixture of #60's acceptance, with each skipped position next to a site. */
const VALUES = `import type { Level } from "./types";

export const DEFAULTS = { status: 413, "retry-after": true };
export const ARTICLES = ["a", "an", "the", "of"];
type Mode = "strict" | "loose";
interface Options {
  level: 3;
}

/** @guarantee ok.counts starts at 0 */
export function counter(initialValue = 0): number {
  return initialValue;
}

/** @guarantee ok.status responds with the default status */
export function status(): number {
  return DEFAULTS.status;
}

/** @guarantee ok.known a known word */
export function isKnown(word: string, mode?: Mode, options?: Options, level?: Level): boolean {
  if (!word) throw new Error("empty word");
  if (typeof mode === "string") return ARTICLES.includes(word);
  return ARTICLES.includes(word);
}

/** @guarantee ok.minor a minor word */
export function isMinor(word: string): boolean {
  return /^(a|an|the)$/.test(word);
}
`;

const TYPES = `export type Level = 1 | 2;
`;

const PINS_FIRST = `import { expect, test } from "bun:test";
import { isKnown } from "../src/values";

test("isKnown.ok.known", () => {
  expect(isKnown("a")).toBe(true);
});
`;

function fixture(): string {
  return project({ "src/values.ts": VALUES, "src/types.ts": TYPES, "tests/values.test.ts": PINS_FIRST });
}

describe("specgate mutants", () => {
  test("#60 acceptance: one entry per value change, none in type positions, imports, typeof checks, thrown messages or keys", async () => {
    const list = await mutantsOf(fixture());
    const rows = list.mutants.map((m) => [m.kind, m.original.replace(/[,\s]/g, ""), m.replacement, m.unit]);
    expect(rows).toEqual([
      ["entry", "status:413", "", "status"],
      ["number", "413", "414", "status"],
      ["entry", '"retry-after":true', "", "status"],
      ["element", '"a"', "", "isKnown"],
      ["element", '"an"', "", "isKnown"],
      ["element", '"the"', "", "isKnown"],
      ["element", '"of"', "", "isKnown"],
      ["number", "0", "1", "counter"],
      ["alternative", "a|", "", "isMinor"],
      ["alternative", "an|", "", "isMinor"],
      ["alternative", "|the", "", "isMinor"],
    ]);
    expect(list.mutants.map((m) => m.description)).toEqual([
      "`status: 413` removed from `DEFAULTS`",
      "`status` in `DEFAULTS` 413 → 414",
      '`"retry-after": true` removed from `DEFAULTS`',
      '`"a"` removed from `ARTICLES`',
      '`"an"` removed from `ARTICLES`',
      '`"the"` removed from `ARTICLES`',
      '`"of"` removed from `ARTICLES`',
      "the default `initialValue` 0 → 1",
      "`a` removed from the regex `/^(a|an|the)$/`",
      "`an` removed from the regex `/^(a|an|the)$/`",
      "`the` removed from the regex `/^(a|an|the)$/`",
    ]);
    expect(list.mutants.map((m) => m.id)).toEqual(list.mutants.map((_, i) => `value-${i + 1}`));
    // The membership decisions are carried along.
    expect(list.mutants[3]?.decision).toEqual({ kind: "member", values: ["a"] });
    // types.ts is reached by no unit with guarantees.
    expect(Object.keys(list.files)).toEqual(["src/values.ts"]);
  });

  test("offsets are UTF-16 offsets into the file, and the changed file still parses", async () => {
    const dir = fixture();
    const list = await mutantsOf(dir);
    const text = readFileSync(join(dir, "src/values.ts"), "utf8");
    for (const m of list.mutants) {
      expect(text.slice(m.start, m.end)).toBe(m.original);
      const lines = text.slice(0, m.start).split("\n");
      expect(m.line).toBe(lines.length);
      expect(m.column).toBe((lines.at(-1)?.length ?? 0) + 1);
      const changed = mutatedText(text, m);
      expect(changed.startsWith("// @ts-nocheck\n")).toBe(true);
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(changed)).not.toThrow();
    }
  });

  test("strings get a suffix, negative numbers stay negative, helpers count and units without guarantees give nothing", async () => {
    const dir = project({
      "src/text.ts": `const SEPARATOR = "-";

/** @guarantee ok.joins joins words */
export function join(words: string[], separator?: string): string {
  return words.join(separator ?? SEPARATOR) + suffix();
}

function suffix(): string {
  return "!";
}

/** @guarantee ok.sign the sign */
export function sign(n: number): number {
  return n < 0 ? -1 : 2;
}

export function untested(): string {
  return "nobody";
}
`,
    });
    const list = await mutantsOf(dir);
    expect(list.mutants.map((m) => [m.kind, m.original, m.replacement, m.unit, m.description])).toEqual([
      ["string", '"-"', '"-_x"', "join", '`SEPARATOR` "-" → "-_x"'],
      ["string", '"!"', '"!_x"', "join", '`return "!";`: "!" → "!_x"'],
      ["number", "0", "1", "sign", "`n < 0`: 0 → 1"],
      ["number", "1", "2", "sign", "`n < 0 ? -1 : 2`: -1 → -2"],
      ["number", "2", "3", "sign", "`n < 0 ? -1 : 2`: 2 → 3"],
    ]);
  });

  test("the command writes .specgate/mutants.json and runs no test", async () => {
    const dir = fixture();
    writeFileSync(
      join(dir, "specgate.config.json"),
      JSON.stringify({
        surface: { include: ["src/**/*.ts"], mode: "exported" },
        tests: { include: ["tests/**/*.test.ts"] },
      }),
    );
    const quiet = spyOn(globalThis.console, "log").mockImplementation(() => {});
    try {
      expect(await main(["mutants", "--cwd", dir])).toBe(0);
    } finally {
      quiet.mockRestore();
    }
    const written = JSON.parse(readFileSync(join(dir, ".specgate/mutants.json"), "utf8")) as ValueMutantList;
    expect(written.schemaVersion).toBe("1");
    expect(written.mutants).toHaveLength(11);
    expect(written.files["src/values.ts"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("value-mutant runner", () => {
  test("#60 acceptance: with a test that pins only the first element, the other three removals survive", async () => {
    const dir = fixture();
    const list = await mutantsOf(dir);
    const before = readFileSync(join(dir, "src/values.ts"), "utf8");
    const { results } = await runValueMutants(list, { root: dir, command: `'${process.execPath}' test` });
    expect(readFileSync(join(dir, "src/values.ts"), "utf8")).toBe(before);
    const elements = results.filter((r) => r.mutant.kind === "element");
    expect(elements.map((r) => [r.mutant.original.replace(/[,\s]/g, ""), r.status])).toEqual([
      ['"a"', "Killed"],
      ['"an"', "Survived"],
      ['"the"', "Survived"],
      ['"of"', "Survived"],
    ]);
    const report = toReport(results, dir) as { schemaVersion: string; files: Record<string, { mutants: unknown[] }> };
    expect(report.schemaVersion).toBe("2");
    expect(report.files["src/values.ts"]?.mutants[3]).toMatchObject({
      id: "value-4",
      mutatorName: "Value",
      replacement: '`"a"` removed from `ARTICLES`',
      status: "Killed",
      location: { start: { line: 4 }, end: { line: 4 } },
    });
  }, 60_000);

  test("a stale list is not applied", async () => {
    const dir = fixture();
    const list = await mutantsOf(dir);
    writeFileSync(join(dir, "src/values.ts"), `${VALUES}\n// edited\n`);
    const { results } = await runValueMutants(list, { root: dir, command: "true" });
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["Ignored"]));
  });

  test("test selection follows the innermost Stryker mutant around the site", () => {
    const site = { file: "src/a.ts", line: 5, column: 10, endLine: 5, endColumn: 12 } as ValueMutant;
    const coverage = (
      mutants: StrykerCoverage["mutants"] extends Map<string, infer M> ? M : never,
    ): StrykerCoverage => ({
      mutants: new Map([["src/a.ts", mutants]]),
      testFile: new Map([
        ["t1", "tests/a.test.ts"],
        ["t2", "tests/b.test.ts"],
      ]),
    });
    const block = { file: "src/a.ts", start: { line: 2, column: 1 }, end: { line: 9, column: 2 }, static: false };
    const inner = { file: "src/a.ts", start: { line: 5, column: 3 }, end: { line: 5, column: 20 }, static: false };
    expect(selectTests(site, undefined)).toEqual({ all: true });
    expect(
      selectTests(
        site,
        coverage([
          { ...block, coveredBy: ["t1", "t2"] },
          { ...inner, coveredBy: ["t2"] },
        ]),
      ),
    ).toEqual({
      files: ["tests/b.test.ts"],
      tests: ["t2"],
    });
    expect(selectTests(site, coverage([{ ...block, coveredBy: [] }]))).toEqual({ none: true });
    expect(selectTests(site, coverage([{ ...block, coveredBy: ["t1"], static: true }]))).toEqual({ all: true });
    expect(selectTests(site, coverage([{ ...block }]))).toEqual({ all: true });
    expect(selectTests(site, coverage([{ ...inner, start: { line: 6, column: 1 }, coveredBy: ["t1"] }]))).toEqual({
      all: true,
    });
    expect(commandFor("npx vitest run", ["tests/a.test.ts"])).toBe("npx vitest run 'tests/a.test.ts'");
    expect(commandFor("npx jest {files} --ci", ["a b.ts"])).toBe("npx jest 'a b.ts' --ci");
    expect(commandFor("npx jest {files} --ci", [])).toBe("npx jest  --ci");
  });
});

describe("value report read back", () => {
  /** A hand-written Stryker report: one survivor in isMinor, one killed mutant in counter. */
  function strykerReport(source: string): string {
    const line = (needle: string) => source.split("\n").findIndex((l) => l.includes(needle)) + 1;
    return JSON.stringify({
      schemaVersion: "2",
      thresholds: { high: 80, low: 60 },
      files: {
        "src/values.ts": {
          language: "typescript",
          source,
          mutants: [
            {
              id: "1",
              mutatorName: "Regex",
              replacement: "/^(a|an|the)/",
              status: "Survived",
              location: { start: { line: line("/^(a|an"), column: 10 }, end: { line: line("/^(a|an"), column: 25 } },
            },
            {
              id: "2",
              mutatorName: "BlockStatement",
              replacement: "{}",
              status: "Killed",
              location: {
                start: { line: line("export function counter"), column: 50 },
                end: { line: line("export function counter") + 2, column: 2 },
              },
            },
          ],
        },
      },
    });
  }

  test("#60 acceptance: check with both reports gives one mutant-survived per survivor, on its unit, in contract terms", async () => {
    const dir = fixture();
    const list = await mutantsOf(dir);
    const { results } = await runValueMutants(list, { root: dir, command: `'${process.execPath}' test` });
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports/value.json"), JSON.stringify(toReport(results, dir)));
    writeFileSync(join(dir, "reports/stryker.json"), strykerReport(VALUES));
    const config = configOf(dir, { mutation: { report: ["reports/stryker.json", "reports/value.json"] } });
    const { report } = await analyze(config, { provenance: false, baseline: null });
    const survived = report.findings.filter((f) => f.rule === "mutant-survived");
    const valueSurvivors = results.filter((r) => r.status === "Survived");
    expect(valueSurvivors).toHaveLength(10);
    expect(survived).toHaveLength(valueSurvivors.length + 1);
    expect(report.findings.filter((f) => f.rule === "mutation-report-unreadable")).toEqual([]);
    expect(survived.map((f) => f.message)).toContain(
      "counter: the default `initialValue` 0 → 1 survived; no linked test fails when the code changes like this",
    );
    expect(survived.map((f) => f.message)).toContain(
      'isKnown: `"an"` removed from `ARTICLES` survived; no linked test fails when the code changes like this',
    );
    expect(survived.map((f) => f.message)).toContain(
      "status: `status` in `DEFAULTS` 413 → 414 survived; no linked test fails when the code changes like this",
    );
    expect(survived.some((f) => f.message.startsWith("isMinor: Regex mutant"))).toBe(true);
    for (const r of valueSurvivors) {
      const f = survived.find((s) => s.mutant?.mutator === "Value" && s.message.includes(r.mutant.description));
      expect(f?.unit).toBe(r.mutant.unit);
    }
    expect(report.units.find((u) => u.id === "isKnown")?.mutation).toEqual({
      killed: 1,
      survived: 3,
      noCoverage: 0,
      ignored: 0,
    });
  }, 60_000);

  test('each unreadable report gives its own finding; an equivalent value mutant is accepted with Value:"…"', async () => {
    const dir = project({
      "src/values.ts": VALUES.replace(
        "/** @guarantee ok.counts starts at 0 */",
        '/**\n * @guarantee ok.counts starts at 0\n * @acceptFinding mutant-survived Value:"the default `initialValue` 0 → 1" any start is fine\n */',
      ),
      "src/types.ts": TYPES,
      "tests/values.test.ts": PINS_FIRST,
    });
    const list = await mutantsOf(dir);
    const counter = list.mutants.filter((m) => m.unit === "counter");
    const { results } = await runValueMutants({ ...list, mutants: counter }, { root: dir, command: "true" });
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports/value.json"), JSON.stringify(toReport(results, dir)));

    const missing = await analyze(
      configOf(dir, { mutation: { report: ["reports/value.json", "reports/a.json", "reports/b.json"] } }),
      {
        provenance: false,
        baseline: null,
      },
    );
    expect(missing.report.findings.filter((f) => f.rule === "mutation-report-unreadable").map((f) => f.file)).toEqual([
      "reports/a.json",
      "reports/b.json",
    ]);
    expect(missing.report.findings.filter((f) => f.rule === "mutant-survived")).toEqual([]);

    const { report } = await analyze(configOf(dir, { mutation: { report: ["reports/value.json"] } }), {
      provenance: false,
      baseline: null,
    });
    const finding = report.findings.find((f) => f.rule === "mutant-survived");
    expect(finding).toMatchObject({ unit: "counter", severity: "info", accepted: true });
    expect(report.findings.filter((f) => f.rule === "accept-tag-unused")).toEqual([]);
  });

  test("mutation.report takes a string or a list of strings", () => {
    expect(parseConfig({ mutation: { report: "a.json" } }).mutation.report).toBe("a.json");
    expect(parseConfig({ mutation: { report: ["a.json", "b.json"] } }).mutation.report).toEqual(["a.json", "b.json"]);
    expect(() => parseConfig({ mutation: { report: 3 } })).toThrow(
      "mutation.report must be a string or an array of strings",
    );
  });
});
