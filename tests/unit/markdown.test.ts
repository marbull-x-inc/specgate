import { describe, expect, test } from "bun:test";
import { markdownTableCell } from "../../src/util/markdown.ts";

describe("markdownTableCell", () => {
  test("a pipe never ends the cell, whatever backslashes precede it", () => {
    for (const input of ["a|b", "a\\|b", "a\\\\|b"]) {
      const cell = markdownTableCell(input);
      // every pipe in the output is preceded by an odd number of backslashes
      for (const m of cell.matchAll(/(\\*)\|/g)) expect((m[1] ?? "").length % 2).toBe(1);
    }
  });
  test("backslashes are escaped and line breaks become spaces", () => {
    expect(markdownTableCell("C:\\path")).toBe("C:\\\\path");
    expect(markdownTableCell("one\ntwo\r\nthree\rfour")).toBe("one two three four");
  });
});
