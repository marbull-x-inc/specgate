import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Report, Severity } from "../ir/schema.ts";

/**
 * Reporters. The IR JSON is the primary output; Step Summary and SARIF are projections of it
 * for GitHub Actions and code-scanning, so a CI job needs no extra tooling to show results.
 */
export function writeReportFiles(report: Report, outDir: string): { json: string; summary: string; sarif: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, "report.json");
  const summary = join(outDir, "summary.md");
  const sarif = join(outDir, "report.sarif");
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(summary, renderStepSummary(report));
  writeFileSync(sarif, `${JSON.stringify(toSarif(report), null, 2)}\n`);
  return { json, summary, sarif };
}

const ICON: Record<Severity, string> = { fail: "❌", warn: "⚠️", info: "ℹ️" };

export function renderStepSummary(report: Report): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`## specgate check (${report.mode})`, "");
  lines.push("| Units | Without guarantee | Guarantees | Without test | Tests | Orphan tests | Unlinked tests |");
  lines.push("|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(
    `| ${s.units} | ${s.unitsWithoutGuarantee} | ${s.guarantees} | ${s.guaranteesWithoutTest} | ${s.tests} | ${s.orphanTests} | ${s.unlinkedTests} |`,
    "",
  );
  lines.push(
    `Findings: ${ICON.fail} ${s.findings.fail} fail · ${ICON.warn} ${s.findings.warn} warn · ${ICON.info} ${s.findings.info} info`,
    "",
  );
  if (report.findings.length > 0) {
    lines.push("| | Rule | Where | Message |", "|---|---|---|---|");
    for (const f of report.findings.slice(0, 200)) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
      lines.push(`| ${ICON[f.severity]} | \`${f.rule}\` | ${where} | ${escapeCell(f.message)} |`);
    }
    if (report.findings.length > 200) lines.push("", `… ${report.findings.length - 200} more in report.json`);
    lines.push("");
  }
  lines.push("<details><summary>Guarantee matrix</summary>", "");
  lines.push("| Unit | Guarantee | Kind | Tests |", "|---|---|---|---|");
  for (const unit of report.units) {
    if (unit.guarantees.length === 0) {
      lines.push(`| \`${unit.id}\` | _(none)_ | | |`);
      continue;
    }
    for (const g of unit.guarantees) {
      lines.push(
        `| \`${unit.id}\` | \`${g.id}\` ${escapeCell(g.text)} | ${g.kind} | ${g.tests.length === 0 ? "—" : g.tests.length} |`,
      );
    }
  }
  lines.push("", "</details>", "");
  return `${lines.join("\n")}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const SARIF_LEVEL: Record<Severity, string> = { fail: "error", warn: "warning", info: "note" };

export function toSarif(report: Report): Record<string, unknown> {
  const ruleIds = [...new Set(report.findings.map((f) => f.rule))].sort();
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: report.tool.name,
            version: report.tool.version,
            informationUri: "https://github.com/Marbull-X/specgate",
            rules: ruleIds.map((id) => ({ id, name: id, shortDescription: { text: id } })),
          },
        },
        results: report.findings.map((f) => toSarifResult(f)),
      },
    ],
  };
}

function toSarifResult(f: Finding): Record<string, unknown> {
  return {
    ruleId: f.rule,
    level: SARIF_LEVEL[f.severity],
    message: { text: f.message },
    ...(f.file
      ? {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
                ...(f.line ? { region: { startLine: f.line } } : {}),
              },
            },
          ],
        }
      : {}),
    ...(f.unit || f.guarantee || f.test
      ? {
          properties: {
            ...(f.unit ? { unit: f.unit } : {}),
            ...(f.guarantee ? { guarantee: f.guarantee } : {}),
            ...(f.test ? { test: f.test } : {}),
          },
        }
      : {}),
  };
}

export function renderConsole(report: Report): string {
  const s = report.summary;
  const lines = [
    `specgate check (${report.mode}): ${s.units} units, ${s.guarantees} guarantees, ${s.tests} linked tests`,
    `  fail ${s.findings.fail} · warn ${s.findings.warn} · info ${s.findings.info}`,
  ];
  for (const f of report.findings) {
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    lines.push(`  ${ICON[f.severity]} [${f.rule}]${where} ${f.message}`);
  }
  return lines.join("\n");
}
