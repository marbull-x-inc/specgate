import { mkdirSync, writeFileSync } from "node:fs";
import { irJsonSchema } from "./ir-schema.zod.ts";

mkdirSync("schema", { recursive: true });
writeFileSync("schema/ir.schema.json", `${JSON.stringify(irJsonSchema(), null, 2)}\n`);
