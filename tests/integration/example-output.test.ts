import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { EXPECTED, produceExampleOutput } from "../../scripts/refresh-example-output.ts";

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path)];
  });
}

describe("examples/shop-expected", () => {
  test("matches what scaffold → gen → check → docs produce today (refresh with `bun run example:refresh`)", async () => {
    const produced = await produceExampleOutput();
    const committed = listFiles(EXPECTED).sort();
    expect([...produced.keys()].sort()).toEqual(committed);
    for (const rel of committed) {
      expect(produced.get(rel)).toBe(readFileSync(join(EXPECTED, rel), "utf8"));
    }
  });
});
