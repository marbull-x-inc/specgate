import { describe, expect, test } from "bun:test";
import { defineConfig } from "../../src/config/schema.ts";
import type { Guarantee, Report, TestCase, Unit } from "../../src/ir/schema.ts";
import { evaluateRules } from "../../src/rules/index.ts";

function guarantee(unitId: string, id: string, textHash: string, tests: string[] = []): Guarantee {
  return {
    id,
    key: `${unitId}.${id}`,
    kind: id.split(".")[0] ?? "other",
    source: "guarantee",
    text: id,
    textHash,
    line: 3,
    references: [],
    tests,
  };
}

function unit(id: string, guarantees: Guarantee[], implHash = "impl-a", extra: Partial<Unit> = {}): Unit {
  return {
    id,
    kind: "function",
    operation: id,
    file: "src/a.ts",
    line: 1,
    endLine: 9,
    referencedBy: ["src/b.ts"],
    summary: "",
    params: [],
    returns: "void",
    uses: [],
    modifies: [],
    injectedPorts: [],
    portCalls: [],
    operationCalls: [],
    envInputs: [],
    implHash,
    guarantees,
    examples: [],
    hasDoc: true,
    ...extra,
  };
}

function testCase(key: string, bodyHash: string, status: TestCase["status"] = "test"): TestCase {
  return {
    key,
    unitId: key.split(".")[0] ?? key,
    guaranteeId: key.split(".").slice(1).join("."),
    file: "tests/a.test.ts",
    line: 5,
    title: key,
    status,
    bodyHash,
    requirementIds: [],
  };
}

function report(units: Unit[], tests: TestCase[]): Report {
  return {
    version: "1",
    tool: { name: "specgate", version: "0" },
    generatedAt: "",
    root: "/",
    mode: "advisory",
    units,
    vocabulary: { entities: [], ports: [] },
    tests,
    findings: [],
    summary: {
      units: 0,
      unitsWithoutGuarantee: 0,
      guarantees: 0,
      guaranteesWithoutTest: 0,
      tests: 0,
      orphanTests: 0,
      unlinkedTests: 0,
      findings: { fail: 0, warn: 0, info: 0 },
    },
  };
}

const config = defineConfig({});

function rulesOf(args: Partial<Parameters<typeof evaluateRules>[0]>) {
  return evaluateRules({
    config,
    units: [],
    tests: [],
    unlinked: [],
    docMessages: [],
    baseline: undefined,
    ...args,
  }).map((f) => `${f.severity}:${f.rule}`);
}

describe("evaluateRules", () => {
  test("no guarantee, placeholder, invalid id, duplicate, no test, orphan, todo", () => {
    const units = [
      unit("a", []),
      unit("b", [guarantee("b", "TODO", "h")]),
      unit("c", [
        guarantee("c", "Weird", "h"),
        guarantee("c", "ok.x", "h", ["t"]),
        guarantee("c", "ok.x", "h2", ["t"]),
      ]),
      unit("d", [guarantee("d", "ok.y", "h")]),
    ];
    const tests = [testCase("c.ok.x", "b"), testCase("zzz.ok.orphan", "b"), testCase("d.ok.y", "b", "todo")];
    const found = rulesOf({ units, tests });
    expect(found).toContain("fail:operation-no-guarantee");
    expect(found).toContain("fail:guarantee-placeholder");
    expect(found).toContain("fail:guarantee-id-invalid");
    expect(found).toContain("fail:guarantee-id-duplicate");
    expect(found).toContain("fail:guarantee-no-test");
    expect(found).toContain("fail:test-orphan");
    expect(found).toContain("warn:test-todo");
  });

  test("severity is configuration; off removes the finding, advisory mode does not change it", () => {
    const cfg = defineConfig({ rules: { "operation-no-guarantee": "off", "test-todo": "fail" } });
    const found = evaluateRules({
      config: cfg,
      units: [unit("a", []), unit("d", [guarantee("d", "ok.y", "h", ["t"])])],
      tests: [testCase("d.ok.y", "b", "todo")],
      unlinked: [],
      docMessages: [],
      baseline: undefined,
    }).map((f) => `${f.severity}:${f.rule}`);
    expect(found).toEqual(["fail:test-todo"]);
  });

  test("guarantee text changed without its test changing → warn", () => {
    const base = report(
      [unit("a", [guarantee("a", "ok.x", "old", ["tests/a.test.ts:5"])])],
      [testCase("a.ok.x", "same")],
    );
    const found = rulesOf({
      units: [unit("a", [guarantee("a", "ok.x", "new", ["tests/a.test.ts:5"])])],
      tests: [testCase("a.ok.x", "same")],
      baseline: base,
    });
    expect(found).toContain("warn:guarantee-changed-test-unchanged");
    const changedTest = rulesOf({
      units: [unit("a", [guarantee("a", "ok.x", "new", ["tests/a.test.ts:5"])])],
      tests: [testCase("a.ok.x", "different")],
      baseline: base,
    });
    expect(changedTest).not.toContain("warn:guarantee-changed-test-unchanged");
  });

  test("implementation changed while guarantees and tests stayed → warn", () => {
    const g = [guarantee("a", "ok.x", "h", ["tests/a.test.ts:5"])];
    const base = report([unit("a", g, "impl-a")], [testCase("a.ok.x", "same")]);
    expect(rulesOf({ units: [unit("a", g, "impl-b")], tests: [testCase("a.ok.x", "same")], baseline: base })).toContain(
      "warn:impl-changed-spec-unchanged",
    );
    expect(
      rulesOf({ units: [unit("a", g, "impl-a")], tests: [testCase("a.ok.x", "same")], baseline: base }),
    ).not.toContain("warn:impl-changed-spec-unchanged");
  });

  test("an operation that disappears fails unless another unit @supersedes it", () => {
    const base = report([unit("old", [guarantee("old", "ok.x", "h", ["t"])])], []);
    expect(rulesOf({ units: [], baseline: base })).toContain("fail:operation-removed");
    expect(
      rulesOf({
        units: [unit("new", [guarantee("new", "ok.x", "h", ["t"])], "i", { supersedes: "old" })],
        tests: [testCase("new.ok.x", "b")],
        baseline: base,
      }),
    ).not.toContain("fail:operation-removed");
  });

  test("ports called but not declared, and declared but unused, are reported for methods", () => {
    const u = unit("U#op", [guarantee("U#op", "ok.x", "h", ["t"])], "i", {
      kind: "method",
      target: "U",
      operation: "op",
      uses: ["Clock", "Unused"],
      injectedPorts: [
        { member: "clock", type: "Clock", members: ["now"] },
        { member: "repo", type: "IRepo", members: ["save"] },
      ],
      portCalls: [
        { port: "clock", member: "now", count: 1 },
        { port: "repo", member: "save", count: 1 },
      ],
    });
    const messages = evaluateRules({
      config,
      units: [u],
      tests: [testCase("U#op.ok.x", "b")],
      unlinked: [],
      docMessages: [],
      baseline: undefined,
    })
      .filter((f) => f.rule === "uses-mismatch")
      .map((f) => f.message);
    expect(messages).toEqual([
      "U#op calls ports not declared in @uses/@modifies: IRepo",
      "U#op declares ports it never calls: Unused",
    ]);
  });
});
