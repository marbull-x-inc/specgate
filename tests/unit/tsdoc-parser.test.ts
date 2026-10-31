import { describe, expect, test } from "bun:test";
import { createTsdocParser, parseDocComment } from "../../src/extract/tsdoc-parser.ts";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

const { parser } = createTsdocParser(PACKAGE_ROOT);

describe("parseDocComment", () => {
  test("reads guarantee ids, throws types, uses/modifies and examples", () => {
    const doc = parseDocComment(
      parser,
      `/**
 * Summary line.
 * @remarks Why it is so.
 * @param period - the period
 * @uses Clock, QuestRepository
 * @modifies QuestRepository
 * @throws {@link InvalidPeriodError} err.invalid-period end < start
 * @guarantee ok.within Clock.now ∈ [period.start, period.end] gives result = true
 * @guarantee ok.unbounded period = null gives result = true
 * @example
 * \`\`\`ts
 * isWithinPeriod(null, clock) // => true
 * \`\`\`
 */`,
    );
    expect(doc.summary).toBe("Summary line.");
    expect(doc.remarks).toBe("Why it is so.");
    expect(doc.params.get("period")).toBe("the period");
    expect(doc.uses).toEqual(["Clock", "QuestRepository"]);
    expect(doc.modifies).toEqual(["QuestRepository"]);
    expect(doc.throws).toEqual([
      { errorType: "InvalidPeriodError", idToken: "err.invalid-period", text: "end < start", lineOffset: 6 },
    ]);
    expect(doc.guarantees.map((g) => [g.idToken, g.lineOffset])).toEqual([
      ["ok.within", 7],
      ["ok.unbounded", 8],
    ]);
    expect(doc.examples).toEqual([{ expression: "isWithinPeriod(null, clock)", expected: "true", lineOffset: 10 }]);
    expect(doc.messages).toEqual([]);
  });

  test("a guarantee whose first token is prose has no id", () => {
    const doc = parseDocComment(parser, "/**\n * @guarantee 成功時に記録が増える\n */");
    expect(doc.guarantees[0]?.idToken).toBeUndefined();
    expect(doc.guarantees[0]?.text).toBe("成功時に記録が増える");
  });

  test("undefined tags are reported, HTML/escape pedantry is not", () => {
    const doc = parseDocComment(parser, "/**\n * a < b and // => c\n * @unknownTag x\n */");
    expect(doc.messages.map((m) => m.text)).toEqual([
      'The TSDoc tag "@unknownTag" is not defined in this configuration',
    ]);
  });

  test("modifier tags @entity and @port are recognised", () => {
    expect(parseDocComment(parser, "/** @entity @invariant start <= end */").isEntity).toBe(true);
    expect(parseDocComment(parser, "/** @port */").isPort).toBe(true);
  });
});

describe("createTsdocParser", () => {
  test("falls back to built-in tags when a tsdoc.json extends an unresolvable package", () => {
    const { configMessages } = createTsdocParser(`${PACKAGE_ROOT}/tests/fixtures/broken-tsdoc`);
    expect(configMessages[0]).toContain("does-not-exist/tsdoc.json");
  });
});
