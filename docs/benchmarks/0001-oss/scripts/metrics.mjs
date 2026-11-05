#!/usr/bin/env node
// Computes the benchmark's metrics from data/<project>/ and writes data/metrics.json.
//   node metrics.mjs <data-dir>
//
// Inputs per project:
//   specgate-static.json, specgate-mutation.json   specgate reports
//   mutation-summary.json                          every Stryker mutant
//   oracle/survivors.json                          equivalence verdict per Survived/NoCoverage mutant
//   oracle/static-verdicts.json                    verdict per static finding (decision-*, test-tautology)
//   timings.json
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.argv[2];
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const STATIC = /^(decision-untested|decision-unspecified|test-tautology)$/;
const projects = readdirSync(dataDir).filter((d) => existsSync(join(dataDir, d, "mutation-summary.json")));
const out = {};

for (const p of projects) {
  const dir = join(dataDir, p);
  const st = read(join(dir, "specgate-static.json"));
  const mu = read(join(dir, "specgate-mutation.json"));
  const summary = read(join(dir, "mutation-summary.json"));
  const survivorsPath = join(dir, "oracle/survivors.json");
  const verdictsPath = join(dir, "oracle/static-verdicts.json");
  const eq = existsSync(survivorsPath) ? read(survivorsPath) : [];
  const verdicts = existsSync(verdictsPath) ? read(verdictsPath) : [];
  const eqById = new Map(eq.map((e) => [String(e.id), e]));

  // 1. precision of static rules
  const staticFindings = st.findings.filter((f) => STATIC.test(f.rule));
  const precision = {};
  for (const v of verdicts) {
    const k = v.rule;
    precision[k] ??= { judged: 0, real: 0, pinned: 0, notApplicable: 0 };
    precision[k].judged++;
    if (v.verdict === "real") precision[k].real++;
    else if (v.verdict === "pinned") precision[k].pinned++;
    else precision[k].notApplicable++;
  }

  // survivors
  const survivors = summary.mutants.filter((m) => m.status === "Survived" || m.status === "NoCoverage");
  const nonEq = survivors.filter((m) => !(eqById.get(String(m.id))?.equivalent === true));

  // 2. unique contribution: real static holes no survivor expresses (from the verdict file)
  const real = verdicts.filter((v) => v.verdict === "real");
  const unique = real.filter((v) => !(v.expressedBy?.length > 0));
  const uniqueByKind = {};
  for (const v of unique) uniqueByKind[v.category] = (uniqueByKind[v.category] ?? 0) + 1;

  // 3. converse: non-equivalent survivors no static finding points at (same file, line, decision)
  const pointed = (m) =>
    verdicts.some(
      (v) =>
        v.file === m.file &&
        v.line === m.line &&
        (m.original.includes(v.value) || (v.kind === "boundary" && /Equality|Conditional/.test(m.mutator))),
    );
  const converse = nonEq.filter((m) => !pointed(m));

  // 4. explanation coverage
  const mutFindings = mu.findings.filter((f) => f.rule === "mutant-survived" && f.mutant);
  const byMutant = new Map();
  for (const f of mutFindings) byMutant.set(String(f.mutant.id), [...(byMutant.get(String(f.mutant.id)) ?? []), f]);
  const explained = nonEq.filter((m) => byMutant.has(String(m.id)));
  const named = explained.filter((m) => byMutant.get(String(m.id)).some((f) => /\((the |membership )/.test(f.message)));
  const unitNotExecuted = mu.findings.filter((f) => f.rule === "unit-not-executed").length;

  // 5. applicability
  const units = st.units.filter((u) => u.kind === "function" || u.kind === "method");
  const decisionsByKind = {};
  for (const u of units) for (const d of u.decisions) decisionsByKind[d.kind] = (decisionsByKind[d.kind] ?? 0) + 1;
  const linkedTests = st.tests.length;

  const timings = existsSync(join(dir, "timings.json")) ? read(join(dir, "timings.json")) : {};
  const sg = timings.specgateStaticSeconds ?? [];
  out[p] = {
    staticFindings: staticFindings.length,
    precision,
    realStaticHoles: real.length,
    unique: unique.length,
    uniqueByKind,
    mutants: summary.mutants.length,
    statusCounts: summary.counts,
    survivors: survivors.length,
    equivalent: survivors.length - nonEq.length,
    nonEquivalentSurvivors: nonEq.length,
    converse: converse.length,
    pointedByStatic: nonEq.length - converse.length,
    explainedByUnit: explained.length,
    explainedWithDecision: named.length,
    mutantSurvivedFindings: mutFindings.length,
    unitNotExecuted,
    units: units.length,
    unitsWithGuarantees: units.filter((u) => u.guarantees.length > 0).length,
    guarantees: units.reduce((a, u) => a + u.guarantees.length, 0),
    decisions: units.reduce((a, u) => a + u.decisions.length, 0),
    decisionsByKind,
    linkedTests,
    unitsWithoutDecisions: units.filter((u) => u.decisions.length === 0).map((u) => u.id),
    strykerSeconds: timings.strykerSeconds ?? null,
    specgateStaticMedianSeconds: sg.length ? sg[Math.floor(sg.length / 2)] : null,
    unexplainedSurvivorIds: nonEq.filter((m) => !byMutant.has(String(m.id))).map((m) => `${m.id}@${m.file}:${m.line}`),
  };
}
writeFileSync(join(dataDir, "metrics.json"), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out, (k, v) => (k === "unexplainedSurvivorIds" ? v.length : v), 2)}\n`);
