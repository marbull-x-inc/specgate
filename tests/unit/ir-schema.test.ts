import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { irJsonSchema, type zReport } from "../../scripts/ir-schema.zod.ts";
import type { Report } from "../../src/ir/schema.ts";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

// Compile-time parity: every hand-written Report is accepted by the Zod mirror (the mirror's
// output type only differs in spelling optional fields as `| undefined`).
const fromReport = (r: Report): z.infer<typeof zReport> => r;
void fromReport;

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
