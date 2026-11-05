#!/usr/bin/env node
// Lists the value mutants that kept the tests green (Survived, NoCoverage) with the source line
// and the Stryker Survived / NoCoverage mutants on the same line, for the equivalence review.
//
//   node green.mjs <project>
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const data = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", process.argv[2]);
const value = JSON.parse(readFileSync(join(data, "value-report.json"), "utf8"));
const stryker = JSON.parse(readFileSync(join(data, "mutation-summary.json"), "utf8")).mutants;
const strykerFile = (f) => (file) => file === f || f.endsWith(`/${file}`) || file.endsWith(`/${f}`);
for (const [file, entry] of Object.entries(value.files)) {
  const lines = entry.source.split("\n");
  for (const m of entry.mutants) {
    if (m.status !== "Survived" && m.status !== "NoCoverage") continue;
    const line = m.location.start.line;
    const near = stryker.filter(
      (s) =>
        strykerFile(file)(s.file) &&
        (s.status === "Survived" || s.status === "NoCoverage") &&
        s.line <= line &&
        s.endLine >= line,
    );
    process.stdout.write(
      `${m.id} ${m.status} ${file}:${line} | ${m.description}\n    ${lines[line - 1]?.trim().slice(0, 140)}\n` +
        near.map((s) => `    stryker ${s.id} ${s.status} ${s.mutator} L${s.line}-${s.endLine} ${JSON.stringify(s.replacement)?.slice(0, 60)}\n`).join(""),
    );
  }
}
