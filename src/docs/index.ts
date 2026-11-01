import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Report, Unit } from "../ir/schema.ts";
import { markdownTableCell } from "../util/markdown.ts";

/**
 * Renders code-derived documentation from the IR.
 *
 * @remarks
 * Three questions, three sources. *What* holds comes from guarantees and the tests that name
 * them. *Why* comes from `@remarks`, copied verbatim. *How* an operation runs is extracted from
 * the implementation (ports called, operations called, environment inputs) and regenerated
 * every time, so it cannot drift from the code the way a hand-written walkthrough would.
 */
export interface DocsResult {
  files: Array<{ path: string; content: string }>;
}

const cell = markdownTableCell;

function signature(unit: Unit): string {
  const params = unit.params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ");
  if (unit.kind === "port") return `interface ${unit.operation}`;
  return `${unit.kind === "method" ? `${unit.target}#` : ""}${unit.operation}(${params}): ${unit.returns}`;
}

function provenanceCell(unit: Unit, g: Unit["guarantees"][number]): string {
  void unit;
  const p = g.provenance;
  if (!p) return "";
  const intro = p.introduced
    ? `${p.introduced.commit.slice(0, 7)}${p.introduced.pr ? ` (PR ${p.introduced.pr})` : ""}`
    : "";
  const last =
    p.lastChanged && p.lastChanged.commit !== p.introduced?.commit
      ? ` → ${p.lastChanged.commit.slice(0, 7)}${p.lastChanged.pr ? ` (PR ${p.lastChanged.pr})` : ""}`
      : "";
  return `${intro}${last}`;
}

function renderUnit(unit: Unit, report: Report): string {
  const lines: string[] = [];
  lines.push(`## ${unit.id}`, "");
  lines.push(`\`${signature(unit)}\`  `, `${unit.file}:${unit.line}`, "");
  if (unit.summary) lines.push(unit.summary, "");
  if (unit.remarks) lines.push("### Why", "", unit.remarks, "");
  if (unit.params.length > 0) {
    lines.push("### Parameters", "", "| Name | Type | Constraint |", "|---|---|---|");
    for (const p of unit.params) lines.push(`| \`${p.name}\` | \`${cell(p.type)}\` | ${cell(p.doc ?? "")} |`);
    lines.push("");
  }
  lines.push("### Guarantees", "");
  if (unit.guarantees.length === 0) {
    lines.push("_No guarantees declared._", "");
  } else {
    lines.push("| Id | Kind | Statement | Tests | Since |", "|---|---|---|---|---|");
    for (const g of unit.guarantees) {
      const stmt = g.throws ? `throws \`${g.throws}\` — ${g.text}` : g.text;
      const tests = g.tests.length === 0 ? "—" : g.tests.map((t) => `\`${t}\``).join("<br>");
      lines.push(`| \`${g.id}\` | ${g.kind} | ${cell(stmt)} | ${tests} | ${provenanceCell(unit, g)} |`);
    }
    lines.push("");
  }
  if (unit.examples.length > 0) {
    lines.push("### Examples", "", "```ts");
    for (const e of unit.examples) lines.push(`${e.expression} // => ${e.expected}`);
    lines.push("```", "");
  }
  if (unit.kind !== "port") {
    lines.push("### How it runs (extracted from the implementation)", "");
    const declared = new Set([...unit.uses, ...unit.modifies]);
    const memberToType = new Map(unit.injectedPorts.map((p) => [p.member, p.type] as const));
    if (unit.portCalls.length > 0) {
      lines.push("| Port | Member | Calls | Declared |", "|---|---|---|---|");
      for (const c of unit.portCalls) {
        const type = memberToType.get(c.port) ?? c.port;
        const isDeclared = declared.has(type) || declared.has(type.replace(/^I(?=[A-Z])/, ""));
        lines.push(
          `| \`${type}\` | \`${c.member}\` | ${c.count} | ${isDeclared ? (unit.modifies.includes(type) ? "modifies" : "uses") : "**undeclared**"} |`,
        );
      }
      lines.push("");
    } else {
      lines.push("_Calls no ports._", "");
    }
    if (unit.operationCalls.length > 0)
      lines.push(
        `Calls public operations: ${unit.operationCalls.map((o) => `[\`${o}\`](#${anchor(o)})`).join(", ")}`,
        "",
      );
    if (unit.envInputs.length > 0)
      lines.push(
        `Direct environment inputs: ${unit.envInputs.map((e) => `\`${e.expression}\` (line ${e.line})`).join(", ")}`,
        "",
      );
    if (unit.referencedBy.length > 0)
      lines.push(`Referenced by: ${unit.referencedBy.map((f) => `\`${f}\``).join(", ")}`, "");
  }
  const unitTests = report.tests.filter((t) => t.unitId === unit.id);
  if (unitTests.length > 0) {
    lines.push("### Tests", "");
    for (const t of unitTests)
      lines.push(`- \`${t.key}\` ${t.status === "test" ? "" : `(${t.status}) `}— ${t.file}:${t.line}`);
    lines.push("");
  }
  return lines.join("\n");
}

function anchor(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function renderDocs(report: Report): DocsResult {
  const files: DocsResult["files"] = [];
  const byFile = new Map<string, Unit[]>();
  for (const u of report.units) {
    const list = byFile.get(u.file) ?? [];
    list.push(u);
    byFile.set(u.file, list);
  }
  for (const [file, units] of byFile) {
    const content = [
      `# ${file}`,
      "",
      `_Generated by specgate docs from ${report.tool.name} ${report.tool.version}; do not edit._`,
      "",
      ...units.map((u) => renderUnit(u, report)),
    ].join("\n");
    files.push({ path: `${file.replace(/\.tsx?$/, "")}.md`, content });
  }
  const index: string[] = [
    "# Specification index",
    "",
    `_Generated ${report.generatedAt}. Units: ${report.summary.units}, guarantees: ${report.summary.guarantees}._`,
    "",
  ];
  index.push("| Unit | Guarantees | Without test | File |", "|---|---:|---:|---|");
  for (const u of report.units) {
    index.push(
      `| [\`${u.id}\`](${u.file.replace(/\.tsx?$/, "")}.md#${anchor(u.id)}) | ${u.guarantees.length} | ${u.guarantees.filter((g) => g.tests.length === 0).length} | ${u.file} |`,
    );
  }
  index.push("", "See [vocabulary.md](vocabulary.md) for entities and ports.", "");
  files.push({ path: "index.md", content: index.join("\n") });

  const vocab: string[] = [
    "# Vocabulary",
    "",
    "Words a guarantee may use besides parameters and `result`.",
    "",
    "## Entities",
    "",
  ];
  if (report.vocabulary.entities.length === 0) vocab.push("_None declared with `@entity`._", "");
  for (const e of report.vocabulary.entities) {
    vocab.push(`### ${e.name}`, "", `${e.description}  `, `${e.file}:${e.line}`, "");
    if (e.properties.length > 0) vocab.push(`Properties: ${e.properties.map((p) => `\`${p}\``).join(", ")}`, "");
    if (e.invariants.length > 0) vocab.push("Invariants:", "", ...e.invariants.map((i) => `- ${i.text}`), "");
  }
  vocab.push("## Ports", "");
  if (report.vocabulary.ports.length === 0) vocab.push("_None declared with `@port`._", "");
  for (const p of report.vocabulary.ports) {
    vocab.push(
      `### ${p.name}`,
      "",
      `${p.description}  `,
      `${p.file}:${p.line}`,
      "",
      `Members: ${p.members.map((m) => `\`${m}\``).join(", ")}`,
      "",
    );
  }
  files.push({ path: "vocabulary.md", content: vocab.join("\n") });
  return { files };
}

export function writeDocs(result: DocsResult, outDir: string): string[] {
  const paths: string[] = [];
  for (const f of result.files) {
    const path = join(outDir, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${f.content.replace(/\s*$/, "")}\n`);
    paths.push(path);
  }
  return paths;
}
