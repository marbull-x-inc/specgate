#!/usr/bin/env node
// Prints the findings of a specgate report.json, one per line, for judging.
//   node findings.mjs <report.json> [rule-regex]
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const re = new RegExp(process.argv[3] ?? ".");
const counts = {};
for (const f of r.findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
process.stdout.write(`${JSON.stringify(counts)}\n`);
r.findings.forEach((f, i) => {
  if (!re.test(f.rule)) return;
  process.stdout.write(
    `${`#${i} [${f.rule}/${f.severity}] ${f.file}:${f.line} ${f.unit ?? f.unitId ?? ""} ${f.message}`}\n`,
  );
});
