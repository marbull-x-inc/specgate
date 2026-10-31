import { describe, expect, test } from "bun:test";
import { parseBlame } from "../../src/provenance/git.ts";

const PORCELAIN = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
author A
author-time 1700000000
summary feat: first (#12)
filename x.ts
\tline one
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2
\tline two
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1
author B
author-time 1800000000
summary fix: second
filename x.ts
\tline three
`;

describe("parseBlame", () => {
  test("maps every line to its commit, reusing headers for repeated commits", () => {
    const lines = parseBlame(PORCELAIN);
    expect(lines.get(1)).toEqual({ commit: "a".repeat(40), authorTime: 1700000000, summary: "feat: first (#12)" });
    expect(lines.get(2)).toEqual({ commit: "a".repeat(40), authorTime: 1700000000, summary: "feat: first (#12)" });
    expect(lines.get(3)).toEqual({ commit: "b".repeat(40), authorTime: 1800000000, summary: "fix: second" });
    expect(lines.get(4)).toBeUndefined();
  });
});
