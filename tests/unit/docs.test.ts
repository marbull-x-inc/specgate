import { describe, expect, test } from "bun:test";
import { renderDocs } from "../../src/docs/index.ts";
import type { Report } from "../../src/ir/schema.ts";
import { renderStepSummary, toSarif } from "../../src/report/index.ts";

const report: Report = {
  version: "1",
  tool: { name: "specgate", version: "0.0.0" },
  generatedAt: "2026-01-01T00:00:00.000Z",
  root: "/repo",
  mode: "advisory",
  units: [
    {
      id: "Quest#complete",
      kind: "method",
      target: "Quest",
      operation: "complete",
      file: "src/quest.ts",
      line: 10,
      endLine: 20,
      referencedBy: ["src/main.ts"],
      summary: "Completes a quest.",
      remarks: "Because reasons.",
      params: [{ name: "id", type: "string", optional: false, doc: "quest id" }],
      returns: "Promise<void>",
      uses: ["Clock"],
      modifies: ["QuestRepository"],
      injectedPorts: [
        { member: "clock", type: "Clock", members: ["now"] },
        { member: "quests", type: "QuestRepository", members: ["save"] },
        { member: "mailer", type: "Mailer", members: ["send"] },
      ],
      portCalls: [
        { port: "clock", member: "now", count: 1 },
        { port: "quests", member: "save", count: 2 },
        { port: "mailer", member: "send", count: 1 },
      ],
      operationCalls: ["isWithinPeriod"],
      envInputs: [{ expression: "Math.random", line: 15 }],
      decisions: [],
      implHash: "h",
      guarantees: [
        {
          id: "ok.done",
          key: "Quest#complete.ok.done",
          kind: "ok",
          source: "guarantee",
          text: "quest is DONE | yes",
          textHash: "t",
          line: 5,
          references: [],
          tests: ["tests/q.test.ts:3"],
          provenance: {
            introduced: { commit: "abcdef0123456789", date: "2026-01-01T00:00:00.000Z", pr: "7" },
            lastChanged: { commit: "fedcba9876543210", date: "2026-02-01T00:00:00.000Z" },
          },
        },
        {
          id: "err.missing",
          key: "Quest#complete.err.missing",
          kind: "err",
          source: "throws",
          text: "id unknown",
          textHash: "t2",
          throws: "NotFoundError",
          line: 6,
          references: [],
          tests: [],
        },
      ],
      examples: [{ expression: "complete('a')", expected: "undefined", line: 7 }],
      hasDoc: true,
    },
  ],
  vocabulary: {
    entities: [
      {
        name: "zQuest",
        file: "src/quest.ts",
        line: 1,
        properties: ["id"],
        invariants: [{ text: "id is a ULID", textHash: "x" }],
        description: "A quest.",
      },
    ],
    ports: [{ name: "Clock", file: "src/clock.ts", line: 1, members: ["now"], vocabulary: [], description: "Time." }],
  },
  tests: [
    {
      key: "Quest#complete.ok.done",
      unitId: "Quest#complete",
      guaranteeId: "ok.done",
      file: "tests/q.test.ts",
      line: 3,
      title: "Quest#complete.ok.done …",
      status: "todo",
      bodyHash: "b",
      requirementIds: [],
    },
  ],
  findings: [
    {
      rule: "guarantee-no-test",
      severity: "fail",
      message: "Quest#complete.err.missing has no test naming it",
      file: "src/quest.ts",
      line: 6,
      unit: "Quest#complete",
      guarantee: "Quest#complete.err.missing",
    },
  ],
  summary: {
    units: 1,
    unitsWithoutGuarantee: 0,
    guarantees: 2,
    guaranteesWithoutTest: 1,
    tests: 1,
    orphanTests: 0,
    unlinkedTests: 0,
    findings: { fail: 1, warn: 0, info: 0 },
  },
};

describe("renderDocs", () => {
  const files = new Map(renderDocs(report).files.map((f) => [f.path, f.content]));
  test("one page per source file with what / why / how, plus index and vocabulary", () => {
    expect([...files.keys()].sort()).toEqual(["index.md", "src/quest.md", "vocabulary.md"]);
    const page = files.get("src/quest.md") ?? "";
    expect(page).toContain("`Quest#complete(id: string): Promise<void>`");
    expect(page).toContain("### Why\n\nBecause reasons.");
    expect(page).toContain("| `id` | `string` | quest id |");
    // pipes in statements are escaped, provenance shows introduced → last changed
    expect(page).toContain(
      "| `ok.done` | ok | quest is DONE \\| yes | `tests/q.test.ts:3` | abcdef0 (PR 7) → fedcba9 |",
    );
    expect(page).toContain("throws `NotFoundError` — id unknown | — |");
    expect(page).toContain("| `QuestRepository` | `save` | 2 | modifies |");
    expect(page).toContain("| `Mailer` | `send` | 1 | **undeclared** |");
    expect(page).toContain("Calls public operations: [`isWithinPeriod`](#iswithinperiod)");
    expect(page).toContain("Direct environment inputs: `Math.random` (line 15)");
    expect(page).toContain("- `Quest#complete.ok.done` (todo) — tests/q.test.ts:3");
    expect(files.get("index.md")).toContain(
      "| [`Quest#complete`](src/quest.md#questcomplete) | 2 | 1 | src/quest.ts |",
    );
    expect(files.get("vocabulary.md")).toContain("- id is a ULID");
  });
});

describe("reporters", () => {
  test("step summary has the counts table and the findings table", () => {
    const md = renderStepSummary(report);
    expect(md).toContain("| 1 | 0 | 2 | 1 | 1 | 0 | 0 |");
    expect(md).toContain("| ❌ | `guarantee-no-test` | src/quest.ts:6 |");
    expect(md).toContain("| `Quest#complete` | `ok.done` quest is DONE \\| yes | ok | 1 |");
  });
  test("SARIF 2.1.0 with one rule per rule id and a location per finding", () => {
    const sarif = toSarif(report);
    const run = (sarif["runs"] as Array<Record<string, unknown>>)[0] ?? {};
    const driver = (run["tool"] as { driver: { rules: Array<{ id: string }> } }).driver;
    expect(driver.rules.map((r) => r.id)).toEqual(["guarantee-no-test"]);
    const results = run["results"] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]?.["level"]).toBe("error");
    expect(JSON.stringify(results[0])).toContain('"startLine":6');
  });
});
