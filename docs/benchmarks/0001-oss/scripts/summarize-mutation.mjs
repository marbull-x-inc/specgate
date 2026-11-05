#!/usr/bin/env node
// Flattens a mutation-testing-report-schema report to one row per mutant.
//   node summarize-mutation.mjs <mutation.json>
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const mutants = [];
for (const [file, f] of Object.entries(report.files)) {
  const lines = f.source.split("\n");
  for (const m of f.mutants) {
    mutants.push({
      id: String(m.id),
      file,
      line: m.location.start.line,
      column: m.location.start.column,
      endLine: m.location.end.line,
      mutator: m.mutatorName,
      replacement: m.replacement ?? null,
      original: lines
        .slice(m.location.start.line - 1, m.location.end.line)
        .join("\n")
        .slice(m.location.start.column - 1, m.location.start.line === m.location.end.line ? m.location.end.column - 1 : undefined)
        .slice(0, 200),
      status: m.status,
    });
  }
}
const counts = {};
for (const m of mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
console.log(JSON.stringify({ schemaVersion: report.schemaVersion, counts, mutants }, null, 2));
