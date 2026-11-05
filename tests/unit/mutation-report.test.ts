import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprint } from "../../src/accepted.ts";
import { analyze } from "../../src/analyze.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { renderDocs } from "../../src/docs/index.ts";
import { parseMutationReport } from "../../src/mutation/report.ts";
import { renderStepSummary } from "../../src/report/index.ts";
import { workDir } from "../helpers/paths.ts";

function project(files: Record<string, string>): string {
  const dir = workDir("mutation");
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

async function reportOf(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
    mutation: { report: "reports/mutation.json" },
    ...overrides,
  });
  return (await analyze({ ...config, root: dir }, { provenance: false, baseline: null })).report;
}

const POLICY = `export const BLOCKED = [
  "/blocked/a",
  "/blocked/b",
];

/** @guarantee ok.blocked a \`path\` in \`BLOCKED\` is blocked */
export function isBlocked(path: string): boolean {
  return BLOCKED.includes(path);
}

/** @guarantee ok.adult an \`age\` of 18 or more is adult */
export function isAdult(age: number): boolean {
  return check(age);
}

function check(age: number): boolean {
  return age >= 18;
}

/** @guarantee ok.greets returns a greeting */
export function greet(name: string): string {
  const text = \`hi \${name}\`;
  return text;
}
`;

const TESTS = `import { expect, test } from "bun:test";
import { greet, isAdult, isBlocked } from "../src/policy";

test("isBlocked.ok.blocked", () => {
  expect(isBlocked("/blocked/a")).toBe(true);
});

test("isAdult.ok.adult", () => {
  expect(isAdult(30)).toBe(true);
});

test("greet.ok.greets", () => {
  expect(typeof greet).toBe("function");
});
`;

/** 1-based line of the first line of `source` containing `needle`. */
function lineOf(source: string, needle: string): number {
  const index = source.split("\n").findIndex((l) => l.includes(needle));
  if (index < 0) throw new Error(`no line with ${needle}`);
  return index + 1;
}

function mutant(id: string, mutatorName: string, replacement: string, status: string, line: number) {
  return { id, mutatorName, replacement, status, location: { start: { line, column: 3 }, end: { line, column: 9 } } };
}

/** A hand-written schema v2 report over `source` (POLICY, possibly shifted). */
function reportJson(source: string, path = "src/policy.ts"): string {
  return JSON.stringify({
    schemaVersion: "2",
    thresholds: { high: 80, low: 60 },
    files: {
      [path]: {
        language: "typescript",
        source,
        mutants: [
          mutant("1", "StringLiteral", '""', "Killed", lineOf(source, '"/blocked/a"')),
          mutant("2", "StringLiteral", '""', "Survived", lineOf(source, '"/blocked/b"')),
          mutant("3", "BooleanLiteral", "true", "Killed", lineOf(source, "return BLOCKED")),
          mutant("4", "ConditionalExpression", "false", "Timeout", lineOf(source, "return BLOCKED")),
          mutant("5", "EqualityOperator", "age > 18", "Survived", lineOf(source, "age >= 18")),
          mutant("6", "BooleanLiteral", "true", "Killed", lineOf(source, "return check")),
          mutant("7", "StringLiteral", "``", "NoCoverage", lineOf(source, "const text")),
          mutant("8", "BlockStatement", "{}", "NoCoverage", lineOf(source, "export function greet")),
          mutant("9", "StringLiteral", "``", "Ignored", lineOf(source, "const text")),
          mutant("10", "StringLiteral", '""', "Survived", 999),
        ],
      },
    },
  });
}

describe("mutation report", () => {
  test("a v2 report across units, a helper and a module-level array gives counts, survivors and one unexecuted unit", async () => {
    const dir = project({
      "src/policy.ts": POLICY,
      "tests/policy.test.ts": TESTS,
      "reports/mutation.json": reportJson(POLICY),
    });
    const report = await reportOf(dir);
    const unit = (id: string) => report.units.find((u) => u.id === id);
    expect(unit("isBlocked")?.mutation).toEqual({ killed: 3, survived: 1, noCoverage: 0, ignored: 0 });
    expect(unit("isAdult")?.mutation).toEqual({ killed: 1, survived: 1, noCoverage: 0, ignored: 0 });
    expect(unit("greet")?.mutation).toEqual({ killed: 0, survived: 0, noCoverage: 2, ignored: 1 });
    expect(unit("isAdult")?.helperRanges).toEqual([
      { line: lineOf(POLICY, "function check"), endLine: lineOf(POLICY, "function check") + 2 },
    ]);

    const survived = report.findings.filter((f) => f.rule === "mutant-survived");
    expect(survived.map((f) => [f.unit, f.mutant?.id, f.severity])).toEqual([
      ["isBlocked", "2", "warn"],
      ["isAdult", "5", "warn"],
    ]);
    expect(survived[0]?.message).toBe(
      'isBlocked: StringLiteral mutant in BLOCKED: `""` survived; no linked test fails when the code changes like this',
    );
    expect(survived[1]?.message).toBe(
      'isAdult: EqualityOperator mutant in a helper it calls (the boundary "18"): `age > 18` survived; no linked test fails when the code changes like this',
    );
    expect(survived[1]?.line).toBe(lineOf(POLICY, "age >= 18"));

    const notExecuted = report.findings.filter((f) => f.rule === "unit-not-executed");
    expect(notExecuted.map((f) => [f.unit, f.severity])).toEqual([["greet", "warn"]]);
    expect(notExecuted[0]?.message).toContain("all 2 mutant(s) in it are NoCoverage");
  });

  test("a NoCoverage mutant in a unit the tests do run is reported", async () => {
    const json = JSON.stringify({
      schemaVersion: "3",
      files: {
        "src/policy.ts": {
          language: "typescript",
          source: POLICY,
          mutants: [
            mutant("a", "BooleanLiteral", "true", "Killed", lineOf(POLICY, "return BLOCKED")),
            mutant("b", "MethodExpression", "BLOCKED.some(path)", "NoCoverage", lineOf(POLICY, "return BLOCKED")),
          ],
        },
      },
    });
    const dir = project({ "src/policy.ts": POLICY, "tests/policy.test.ts": TESTS, "reports/mutation.json": json });
    const report = await reportOf(dir);
    expect(report.findings.filter((f) => f.rule === "mutant-survived").map((f) => f.message)).toEqual([
      "isBlocked: MethodExpression mutant (membership in BLOCKED): `BLOCKED.some(path)` is not run by any test",
    ]);
    expect(report.findings.filter((f) => f.rule === "unit-not-executed")).toEqual([]);
  });

  test("the decision on the mutated line is named", async () => {
    const source = `/** @guarantee ok.adult an \`age\` of 18 or more is adult */
export function isAdult(age: number): boolean {
  return age >= 18;
}
`;
    const json = JSON.stringify({
      files: {
        "src/adult.ts": {
          language: "typescript",
          source,
          mutants: [mutant("1", "EqualityOperator", "age > 18", "Survived", 3)],
        },
      },
    });
    const dir = project({
      "src/adult.ts": source,
      "tests/adult.test.ts": `import { expect, test } from "bun:test";
import { isAdult } from "../src/adult";
test("isAdult.ok.adult", () => {
  expect(isAdult(30)).toBe(true);
});
`,
      "reports/mutation.json": json,
    });
    const report = await reportOf(dir);
    expect(report.findings.find((f) => f.rule === "mutant-survived")?.message).toBe(
      'isAdult: EqualityOperator mutant (the boundary "18"): `age > 18` survived; no linked test fails when the code changes like this',
    );
  });

  test("moving the code keeps the fingerprint, so an accepted equivalent mutant stays accepted", async () => {
    const shifted = `\n\n${POLICY}`;
    const before = await reportOf(
      project({ "src/policy.ts": POLICY, "tests/policy.test.ts": TESTS, "reports/mutation.json": reportJson(POLICY) }),
    );
    const after = await reportOf(
      project({
        "src/policy.ts": shifted,
        "tests/policy.test.ts": TESTS,
        "reports/mutation.json": reportJson(shifted),
      }),
    );
    const prints = (r: typeof before) =>
      r.findings.filter((f) => f.rule === "mutant-survived").map((f) => [f.line, fingerprint(f)] as const);
    const [b, a] = [prints(before), prints(after)];
    expect(a.map(([line]) => line)).toEqual(b.map(([line]) => (line ?? 0) + 2));
    expect(a.map(([, f]) => f)).toEqual(b.map(([, f]) => f));
  });

  test("a corrupt or missing report gives one warn and no crash; no report configured gives nothing", async () => {
    const corrupt = await reportOf(
      project({ "src/policy.ts": POLICY, "tests/policy.test.ts": TESTS, "reports/mutation.json": "{ not json" }),
    );
    const unreadable = corrupt.findings.filter((f) => f.rule === "mutation-report-unreadable");
    expect(unreadable.map((f) => [f.severity, f.file])).toEqual([["warn", "reports/mutation.json"]]);
    expect(unreadable[0]?.message).toContain("not valid JSON");
    expect(corrupt.units.some((u) => u.mutation !== undefined)).toBe(false);

    const missing = await reportOf(project({ "src/policy.ts": POLICY, "tests/policy.test.ts": TESTS }));
    expect(missing.findings.filter((f) => f.rule === "mutation-report-unreadable").map((f) => f.message)).toEqual([
      "mutation.report reports/mutation.json: file not found; the mutation rules did not run",
    ]);

    const off = await reportOf(project({ "src/policy.ts": POLICY, "tests/policy.test.ts": TESTS }), {
      mutation: {},
    });
    expect(off.findings.filter((f) => f.rule.startsWith("mutant") || f.rule.includes("mutation"))).toEqual([]);
    expect(off.units.some((u) => u.mutation !== undefined)).toBe(false);
  });

  test("mutation.detected decides what counts as killed", async () => {
    const dir = project({
      "src/policy.ts": POLICY,
      "tests/policy.test.ts": TESTS,
      "reports/mutation.json": reportJson(POLICY),
    });
    const report = await reportOf(dir, { mutation: { report: "reports/mutation.json", detected: ["Killed"] } });
    expect(report.units.find((u) => u.id === "isBlocked")?.mutation).toEqual({
      killed: 2,
      survived: 1,
      noCoverage: 0,
      ignored: 1,
    });
  });
});

describe("parseMutationReport", () => {
  test("paths resolve against projectRoot or root, absolute paths are made relative", () => {
    const m = mutant("1", "StringLiteral", '""', "Killed", 2);
    const result = parseMutationReport(
      {
        projectRoot: "/repo/packages/app",
        files: { "src/a.ts": { mutants: [m] }, "/repo/packages/app/src/b.ts": { mutants: [{ ...m, id: 7 }] } },
      },
      "/repo",
    );
    expect("mutants" in result && result.mutants.map((x) => [x.file, x.id, x.line, x.endLine])).toEqual([
      ["packages/app/src/a.ts", "1", 2, 2],
      ["packages/app/src/b.ts", "7", 2, 2],
    ]);
  });

  test("a value that is not a report says why", () => {
    expect(parseMutationReport([], "/r")).toEqual({ error: "not a JSON object" });
    expect(parseMutationReport({ schemaVersion: "2" }, "/r")).toEqual({
      error: "no `files` object (not a mutation-testing-report-schema report)",
    });
    expect(parseMutationReport({ files: { "a.ts": { mutants: [{ id: "1", status: "Killed" }] } } }, "/r")).toEqual({
      error: 'files["a.ts"].mutants[0].mutatorName is missing',
    });
  });
});

/**
 * StrykerJS 10.1.1 with the vitest runner (schemaVersion "1.0", an absolute projectRoot, and keys
 * the schema leaves open: testFiles, config, framework). Only projectRoot was replaced and the
 * framework's branding removed. The project is rebuilt from the report's own sources.
 */
async function strykerProject(mutation: ConfigInput["mutation"] = {}) {
  const real = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/stryker-report/mutation.json"), "utf8"));
  const source: string = real.files["src/policy.ts"].source;
  const dir = project({
    "src/policy.ts": source,
    "tests/policy.test.ts": real.testFiles["tests/policy.test.ts"].source,
  });
  mkdirSync(join(dir, "reports"));
  writeFileSync(join(dir, "reports/mutation.json"), JSON.stringify({ ...real, projectRoot: dir }));
  return {
    source,
    report: await reportOf(dir, { mutation: { report: "reports/mutation.json", ...mutation } }),
  };
}

describe("a report written by Stryker", () => {
  test("maps every mutant and reports the survivors, helper and collection included", async () => {
    const { source, report } = await strykerProject();

    expect(report.findings.filter((f) => f.rule === "mutation-report-unreadable")).toEqual([]);
    expect(Object.fromEntries(report.units.map((u) => [u.id, u.mutation]))).toEqual({
      isBlocked: { killed: 3, survived: 1, noCoverage: 0, ignored: 0 },
      isAdult: { killed: 4, survived: 2, noCoverage: 0, ignored: 0 },
      greet: { killed: 0, survived: 0, noCoverage: 2, ignored: 0 },
      "Pricing#total": { killed: 5, survived: 2, noCoverage: 0, ignored: 0 },
    });
    const mutationFindings = report.findings
      .filter((f) => f.rule === "mutant-survived" || f.rule === "unit-not-executed")
      .map((f) => [f.rule, f.unit, f.line, f.mutant?.replacement]);
    expect(mutationFindings).toEqual([
      ["mutant-survived", "isBlocked", lineOf(source, '"/blocked/b"'), '""'],
      ["mutant-survived", "isAdult", lineOf(source, "age >= 18"), "true"],
      ["mutant-survived", "isAdult", lineOf(source, "age >= 18"), "age > 18"],
      ["unit-not-executed", "greet", lineOf(source, "export function greet"), undefined],
      ["mutant-survived", "Pricing#total", lineOf(source, "amount >= 100"), "true"],
      ["mutant-survived", "Pricing#total", lineOf(source, "amount >= 100"), "amount > 100"],
    ]);
    expect(report.findings.find((f) => f.mutant?.replacement === "amount > 100")?.message).toBe(
      'Pricing#total: EqualityOperator mutant in a helper it calls (the boundary "100"): `amount > 100` survived; no linked test fails when the code changes like this',
    );
  });

  test("the step summary and the docs show the counts per unit", async () => {
    const { report } = await strykerProject();
    const summary = renderStepSummary(report);
    expect(summary).toContain("<details><summary>Mutants by unit</summary>");
    expect(summary).toContain("| `isAdult` | 4 | 2 | 0 | 0 | 66% |");
    expect(summary).toContain("| `greet` | 0 | 0 | 2 | 0 | 0% |");

    const docs = renderDocs(report).files;
    const page = docs.find((f) => f.path === "src/policy.md")?.content ?? "";
    expect(page).toContain("5 killed, 2 survived, 0 not run by any test, 0 ignored (score 71%).");
    const index = docs.find((f) => f.path === "index.md")?.content ?? "";
    expect(index).toContain("| Unit | Guarantees | Without test | Mutant score | File |");
    expect(index).toContain("| 1 | 0 | 75% | src/policy.ts |");
  });

  test("without a report, neither the summary nor the docs mention mutants", async () => {
    const dir = project({ "src/policy.ts": POLICY, "tests/policy.test.ts": TESTS });
    const report = await reportOf(dir, { mutation: {} });
    expect(renderStepSummary(report)).not.toContain("Mutants");
    const docs = renderDocs(report)
      .files.map((f) => f.content)
      .join("\n");
    expect(docs).not.toContain("Mutant");
  });
});

describe("mutation.findings, listLimit and exclude (#41)", () => {
  test('findings: "unit" gives one finding per unit with survivors, listing at most listLimit', async () => {
    const { source, report } = await strykerProject({ findings: "unit", listLimit: 1 });
    const survived = report.findings.filter((f) => f.rule === "mutant-survived");
    expect(survived.map((f) => [f.unit, f.line]).sort()).toEqual([
      ["Pricing#total", lineOf(source, "amount >= 100")],
      ["isAdult", lineOf(source, "age >= 18")],
      ["isBlocked", lineOf(source, '"/blocked/b"')],
    ]);
    expect(survived.find((f) => f.unit === "isAdult")?.message).toBe(
      `isAdult: 2 mutant(s) the linked tests let through (2 survived): line ${lineOf(source, "age >= 18")} ConditionalExpression mutant in a helper it calls (the boundary "18"): \`true\`; and 1 more`,
    );
    expect(survived.every((f) => f.mutant === undefined)).toBe(true);
    // The counts and unit-not-executed do not change.
    expect(report.units.find((u) => u.id === "isAdult")?.mutation?.survived).toBe(2);
    expect(report.findings.filter((f) => f.rule === "unit-not-executed").map((f) => f.unit)).toEqual(["greet"]);
  });

  test("exclude by unit id or file glob keeps the counts and drops the findings", async () => {
    const byId = await strykerProject({ exclude: ["Pricing#total", "greet"] });
    expect(byId.report.findings.filter((f) => f.rule === "mutant-survived").map((f) => f.unit)).toEqual([
      "isBlocked",
      "isAdult",
      "isAdult",
    ]);
    expect(byId.report.findings.filter((f) => f.rule === "unit-not-executed")).toEqual([]);
    expect(byId.report.units.find((u) => u.id === "Pricing#total")?.mutation?.survived).toBe(2);

    const byGlob = await strykerProject({ exclude: ["src/**/policy.ts"] });
    expect(byGlob.report.findings.filter((f) => f.rule.startsWith("mutant") || f.rule === "unit-not-executed")).toEqual(
      [],
    );
    expect(byGlob.report.units.find((u) => u.id === "greet")?.mutation?.noCoverage).toBe(2);
  });
});

describe("@acceptFinding on a mutant (#40)", () => {
  test('Mutator:"replacement" accepts that mutant next to the code, and only that one', async () => {
    const tagged = POLICY.replace(
      "/** @guarantee ok.adult an `age` of 18 or more is adult */",
      '/**\n * @guarantee ok.adult an `age` of 18 or more is adult\n * @acceptFinding mutant-survived EqualityOperator:"age > 18" ages are whole years and 18 is tested in the caller\n */',
    );
    expect(tagged).not.toBe(POLICY);
    const dir = project({
      "src/policy.ts": tagged,
      "tests/policy.test.ts": TESTS,
      "reports/mutation.json": reportJson(tagged),
    });
    const report = await reportOf(dir);
    const survived = report.findings.filter((f) => f.rule === "mutant-survived");
    expect(survived.map((f) => [f.unit, f.mutant?.replacement, f.severity, f.acceptedReason ?? null])).toEqual([
      ["isBlocked", '""', "warn", null],
      ["isAdult", "age > 18", "info", "ages are whole years and 18 is tested in the caller"],
    ]);
    expect(report.findings.filter((f) => f.rule.startsWith("accept-tag"))).toEqual([]);
  });
});

describe("mutants in module-level constants a unit reads (#53)", () => {
  const SOURCE = `const HEX = /^#[0-9a-f]{6}$/;
const UNUSED = /^x$/;

/** @guarantee ok.hex returns true only for \`#\` and 6 lowercase hex digits */
export const isHex = (value: string): boolean => HEX.test(value);

/** @guarantee ok.color returns true for a hex colour */
export const isColor = (value: string): boolean => HEX.test(value.trim());
`;
  const TEST = `import { expect, it } from "bun:test";
import { isColor, isHex } from "../src/hex";
it("isHex.ok.hex", () => {
  expect(isHex("#a0b1c2")).toBe(true);
  expect(isHex("red")).toBe(false);
});
it("isColor.ok.color", () => {
  expect(isColor(" #a0b1c2 ")).toBe(true);
});
`;
  const json = JSON.stringify({
    schemaVersion: "2",
    files: {
      "src/hex.ts": {
        language: "typescript",
        source: SOURCE,
        mutants: [
          mutant("1", "Regex", "/#[0-9a-f]{6}$/", "Survived", 1),
          mutant("2", "Regex", "/^x/", "Survived", 2),
          mutant("3", "BooleanLiteral", "true", "Killed", lineOf(SOURCE, "export const isHex")),
        ],
      },
    },
  });

  test("count for every unit that reads the constant, name it, and count the rest as unmapped", async () => {
    const dir = project({ "src/hex.ts": SOURCE, "tests/hex.test.ts": TEST, "reports/mutation.json": json });
    const report = await reportOf(dir);
    expect(report.units.find((u) => u.id === "isHex")?.mutation).toEqual({
      killed: 1,
      survived: 1,
      noCoverage: 0,
      ignored: 0,
    });
    expect(report.units.find((u) => u.id === "isColor")?.mutation).toEqual({
      killed: 0,
      survived: 1,
      noCoverage: 0,
      ignored: 0,
    });
    expect(report.findings.filter((f) => f.rule === "mutant-survived").map((f) => f.message)).toEqual([
      "isColor: Regex mutant in HEX: `/#[0-9a-f]{6}$/` survived; no linked test fails when the code changes like this; also reached from isHex",
    ]);
    expect(report.summary.mutantsUnmapped).toBe(1);
    expect(renderStepSummary(report)).toContain("1 mutant(s) in the report map to no unit, so no rule reads them.");
  });
});
