import { analyze } from "../src/analyze.ts";
import { loadConfig } from "../src/config/load.ts";

const dir = process.argv[2] ?? ".";
const { config } = await loadConfig(dir);
const t0 = performance.now();
const { report } = await analyze(config, { provenance: false, baseline: null });
process.stdout.write(
  `${JSON.stringify({ ms: Math.round(performance.now() - t0), summary: report.summary, units: report.units.map((u) => ({ id: u.id, g: u.guarantees.map((g) => [g.id, g.tests.length, g.references.filter((r) => r.kind === "unresolved").map((r) => r.raw)]), ref: u.referencedBy, ports: u.portCalls, calls: u.operationCalls, env: u.envInputs })), vocab: report.vocabulary, tests: report.tests.map((t) => [t.key, t.status]), findings: report.findings.map((f) => `${f.severity} ${f.rule} ${f.message}`) }, null, 1)}\n`,
);
