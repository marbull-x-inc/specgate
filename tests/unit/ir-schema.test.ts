import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { irJsonSchema } from "../../src/ir/schema.ts";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

describe("schema/ir.schema.json", () => {
  test("is the committed form of the Zod IR schema (run `bun run schema:emit` after changing it)", () => {
    const committed = JSON.parse(readFileSync(join(PACKAGE_ROOT, "schema", "ir.schema.json"), "utf8"));
    expect(committed).toEqual(irJsonSchema());
  });
  test("does not mention TypeScript or any tracker", () => {
    const text = JSON.stringify(irJsonSchema());
    expect(text).not.toMatch(/SyntaxKind|ts\.Node|Linear|MARCN|Jira/);
  });
});
