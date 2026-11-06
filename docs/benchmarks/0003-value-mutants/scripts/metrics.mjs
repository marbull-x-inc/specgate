#!/usr/bin/env node
// Counts of benchmark 0003 per project and in total, and the merge criteria C1–C3 (protocol).
//
//   node metrics.mjs            prints a JSON summary (data/metrics.json is written too)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTS } from "./projects.mjs";

const bench = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Whether a guarantee or example of the unit names the value the mutant changes (#62, approximate). */
function named(mutant, unit) {
  if (!unit) return false;
  const corpus = [...unit.guarantees.map((g) => g.text), ...unit.examples.map((e) => e.code ?? e.text ?? "")].join(
    "\n",
  );
  const v =
    mutant.decision?.values?.[0] ?? mutant.original.replace(/^[,\s|]+|[,\s|]+$/g, "").replace(/^['"`]|['"`]$/g, "");
  if (v === "") return false;
  if (/^-?[\d.]+$/.test(v)) return corpus.split(/[^\d.]+/).some((n) => n !== "" && Number(n) === Number(v));
  return corpus.includes(v);
}

const projects = [];
for (const name of Object.keys(PROJECTS)) {
  const d = join(bench, "data", name);
  if (!existsSync(join(d, "value-report.json"))) {
    projects.push({ name, ran: false });
    continue;
  }
  const value = read(join(d, "value-report.json"));
  const list = read(join(d, "mutants.json"));
  const finalStatus = {};
  for (const f of Object.values(read(join(d, "value-report.json")).files))
    for (const m of f.mutants) finalStatus[m.id] = m.status;
  // Verdicts of the mutants green in the final measurement only.
  const verdicts = (existsSync(join(d, "verdicts.json")) ? read(join(d, "verdicts.json")) : []).filter(
    (v) => finalStatus[v.id] === "Survived" || finalStatus[v.id] === "NoCoverage",
  );
  const timings = read(join(d, "timings.json"));
  const stryker = read(join(d, "mutation-summary.json")).counts;
  const report = read(join(d, "specgate-mutation.json"));
  const units = new Map(report.units.map((u) => [u.id, u]));
  const byId = new Map(list.mutants.map((m) => [m.id, m]));
  const status = {};
  for (const f of Object.values(value.files)) for (const m of f.mutants) status[m.status] = (status[m.status] ?? 0) + 1;
  const kinds = {};
  for (const m of list.mutants) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
  const green = (status.Survived ?? 0) + (status.NoCoverage ?? 0);
  const real = verdicts.filter((v) => v.verdict === "real");
  const equivalent = verdicts.filter((v) => v.verdict === "equivalent");
  const unique = real.filter((v) => !v.expressedBy);
  const byCategory = (list, c) => list.filter((v) => (v.category ?? "") === c).length;
  const site = (v) => {
    const m = byId.get(v.id);
    return m ? `${m.file}:${m.line}` : v.id;
  };
  const valueFindings = report.findings.filter((f) => f.rule === "mutant-survived" && f.mutant?.mutator === "Value");
  projects.push({
    name,
    ran: true,
    valueMutants: list.mutants.length,
    kinds,
    status,
    green,
    reviewed: verdicts.length,
    real: real.length,
    equivalent: equivalent.length,
    realNotExpressed: unique.length,
    holeSites: new Set(real.map(site)).size,
    holeSitesNotExpressed: new Set(unique.map(site)).size,
    categories: {
      nodeEnvSwitch: { real: byCategory(real, "node-env-switch"), notExpressed: byCategory(unique, "node-env-switch") },
      logMessage: { real: byCategory(real, "log-message"), notExpressed: byCategory(unique, "log-message") },
      loopLimit: { real: byCategory(real, "loop-limit"), notExpressed: byCategory(unique, "loop-limit") },
    },
    namedByGuarantee: real.filter((v) => named(byId.get(v.id) ?? { original: "" }, units.get(byId.get(v.id)?.unit)))
      .length,
    strykerCounts: stryker,
    strykerSurvivedOrNoCoverage: (stryker.Survived ?? 0) + (stryker.NoCoverage ?? 0),
    seconds: { stryker: timings.strykerSeconds, runner: timings.runnerSeconds, mutants: timings.mutantsSeconds },
    runnerConcurrency: timings.runnerConcurrency,
    valueFindings: valueFindings.length,
    valueFindingsWithUnit: valueFindings.filter((f) => f.unit).length,
  });
}

const ran = projects.filter((p) => p.ran);
const sum = (f) => ran.reduce((n, p) => n + f(p), 0);
const real = sum((p) => p.real);
const equivalent = sum((p) => p.equivalent);
const catReal = sum(
  (p) => p.categories.nodeEnvSwitch.real + p.categories.logMessage.real + p.categories.loopLimit.real,
);
const withUnique = ran.filter((p) => p.realNotExpressed > 0);
const withUniqueExcl = ran.filter(
  (p) =>
    p.realNotExpressed -
      p.categories.nodeEnvSwitch.notExpressed -
      p.categories.logMessage.notExpressed -
      p.categories.loopLimit.notExpressed >
    0,
);
const stryker = sum((p) => p.seconds.stryker);
const runner = sum((p) => p.seconds.runner);
const summary = {
  projectsRan: ran.length,
  C1: {
    projectsWithRealHoleNotExpressed: withUnique.length,
    projects: withUnique.map((p) => p.name),
    needMoreThan: ran.length / 2,
    holds: withUnique.length > ran.length / 2,
    excludingCategories: { projects: withUniqueExcl.length, names: withUniqueExcl.map((p) => p.name) },
  },
  C2: {
    green: sum((p) => p.green),
    reviewed: real + equivalent,
    real,
    equivalent,
    share: real / (real + equivalent),
    holds: real / (real + equivalent) >= 0.7,
    excludingCategories: { real: real - catReal, equivalent, share: (real - catReal) / (real - catReal + equivalent) },
  },
  C3: { strykerSeconds: stryker, runnerSeconds: runner, ratio: runner / stryker, holds: runner / stryker <= 2 },
  totals: {
    valueMutants: sum((p) => p.valueMutants),
    realNotExpressed: sum((p) => p.realNotExpressed),
    holeSitesNotExpressed: sum((p) => p.holeSitesNotExpressed),
    namedByGuarantee: sum((p) => p.namedByGuarantee),
  },
};
const out = { summary, projects };
writeFileSync(join(bench, "data", "metrics.json"), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
