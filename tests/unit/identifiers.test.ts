import { describe, expect, test } from "bun:test";
import { defineConfig } from "../../src/config/schema.ts";
import type { Unit } from "../../src/ir/schema.ts";
import { resolveReferences } from "../../src/resolve/identifiers.ts";

const config = defineConfig({});

function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: "QuestUseCase#completeQuest",
    kind: "method",
    target: "QuestUseCase",
    operation: "completeQuest",
    file: "src/quest.ts",
    line: 1,
    endLine: 2,
    referencedBy: [],
    summary: "",
    params: [
      { name: "accountId", type: "string", optional: false },
      { name: "quest", type: "Quest", optional: false },
    ],
    returns: "Promise<void>",
    uses: ["Clock", "QuestRepository"],
    modifies: ["QuestRepository"],
    injectedPorts: [
      { member: "clock", type: "Clock", members: ["now"] },
      { member: "quests", type: "QuestRepository", members: ["findById", "save"] },
    ],
    portCalls: [],
    operationCalls: [],
    envInputs: [],
    implHash: "x",
    guarantees: [],
    examples: [],
    hasDoc: true,
    ...overrides,
  };
}

const other: Unit = {
  ...unit(),
  id: "QuestCompletionService#checkActivityConstraints",
  target: "QuestCompletionService",
  operation: "checkActivityConstraints",
  guarantees: [
    {
      id: "err.limit",
      key: "QuestCompletionService#checkActivityConstraints.err.limit",
      kind: "err",
      source: "guarantee",
      text: "",
      textHash: "",
      line: 1,
      references: [],
      tests: [],
    },
  ],
};

const scope = {
  units: [unit(), other],
  entities: [
    {
      name: "zQuest",
      file: "src/quest.ts",
      line: 1,
      properties: ["questId", "period"],
      invariants: [],
      description: "",
    },
  ],
  ports: [
    {
      name: "QuestRepository",
      file: "src/ports.ts",
      line: 1,
      members: ["findById", "save"],
      vocabulary: ["questId"],
      description: "",
    },
  ],
  programTypeNames: new Set(["QuestEntity", "DONE", "QuestActivityStatus"]),
};

function kinds(text: string) {
  return resolveReferences(unit(), text, scope, config).map((r) => `${r.raw}:${r.kind}`);
}

describe("resolveReferences", () => {
  test("params, result, declared ports and their members resolve", () => {
    expect(
      kinds(
        "after the call QuestRepository.save(quest) makes findById(quest.questId) equal to quest; result = undefined; Clock.now is read",
      ),
    ).toEqual(["QuestRepository.save:port", "quest:param", "findById:port", "quest.questId:param", "Clock.now:port"]);
  });
  test("other public operations' guarantees resolve, including wildcards", () => {
    expect(
      kinds("follows QuestCompletionService#checkActivityConstraints.err.limit and #checkActivityConstraints.err.*"),
    ).toEqual([
      "QuestCompletionService#checkActivityConstraints.err.limit:operation",
      "#checkActivityConstraints.err.*:operation",
    ]);
    expect(kinds("QuestCompletionService#checkActivityConstraints.err.nope")).toEqual([
      "QuestCompletionService#checkActivityConstraints.err.nope:unresolved",
    ]);
  });
  test("program types, enum members and entity properties resolve; unknown camelCase does not", () => {
    expect(kinds("status is DONE per QuestEntity.determineProgressStatus with questId and clearCount")).toEqual([
      "DONE:type",
      "QuestEntity.determineProgressStatus:type",
      "questId:port",
      "clearCount:unresolved",
    ]);
  });
  test("prose, literals and quoted strings are ignored", () => {
    expect(kinds('記録が 1 件増える。値が "1" でないとき null を返す true/false')).toEqual([]);
  });
  test("configured ignore list suppresses tokens", () => {
    const cfg = defineConfig({ resolve: { ignore: ["clearCount"] } });
    expect(resolveReferences(unit(), "clearCount grows", scope, cfg)).toEqual([]);
  });
});
