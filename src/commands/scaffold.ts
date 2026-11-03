import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config/schema.ts";
import type { ExtractedUnit } from "../extract/surface.ts";

/**
 * Writes TSDoc skeletons for units that have no doc comment or no guarantee tags.
 *
 * @remarks
 * Only signature-derived facts are filled in: parameter names and types, the return type,
 * error classes thrown in the body (unless the doc already has `@throws` for them), and the
 * ports the body calls. An existing `@returns` seeds the first guarantee's statement; the id
 * stays the configured placeholder, because naming the guarantee is a design decision for a
 * person (or an AI assistant outside this tool). `check` reports the placeholders until they are.
 * Port wording appears only when the unit has ports.
 */
export interface ScaffoldOptions {
  dryRun?: boolean;
  unitFilter?: string;
}

export interface ScaffoldResult {
  edits: Array<{ file: string; unit: string; kind: "insert-doc" | "add-tags"; text: string }>;
}

function indentOf(sourceText: string, pos: number): string {
  const lineStart = sourceText.lastIndexOf("\n", pos - 1) + 1;
  const match = /^[ \t]*/.exec(sourceText.slice(lineStart, pos));
  return match?.[0] ?? "";
}

function tagLines(ex: ExtractedUnit, placeholder: string): string[] {
  const unit = ex.unit;
  const lines: string[] = [];
  const memberToType = new Map(unit.injectedPorts.map((p) => [p.member, p.type] as const));
  const usedPorts = [...new Set(unit.portCalls.map((c) => memberToType.get(c.port) ?? c.port))];
  const hasPorts = unit.injectedPorts.length > 0 || usedPorts.length > 0;
  const documented = new Set(ex.doc?.throws.map((t) => t.errorType).filter((t) => t !== undefined));
  for (const err of ex.thrownErrorTypes)
    if (!documented.has(err)) lines.push(`@throws {@link ${err}} ${placeholder} when ${err} is thrown`);
  if (usedPorts.length > 0) lines.push(`@uses ${usedPorts.join(", ")}`);
  if (usedPorts.length > 0) lines.push(`@modifies ${placeholder}`);
  // The existing @returns is the best first draft of what holds after the call.
  const returns = ex.doc?.returns?.replace(/\s+/g, " ").trim();
  if (returns) lines.push(`@guarantee ${placeholder} returns ${returns}`);
  else if (hasPorts)
    lines.push(`@guarantee ${placeholder} what holds afterwards, in params, result and declared ports`);
  else lines.push(`@guarantee ${placeholder} what holds afterwards, in params and result`);
  return lines;
}

function fullDoc(ex: ExtractedUnit, placeholder: string): string[] {
  const unit = ex.unit;
  const lines = [
    `${placeholder}: one sentence on what ${unit.operation} does`,
    `@remarks ${placeholder}: why it is designed this way`,
  ];
  for (const p of unit.params)
    lines.push(`@param ${p.name} - ${placeholder} (${p.type}${p.optional ? ", optional" : ""})`);
  if (unit.returns && unit.returns !== "void" && unit.returns !== "Promise<void>")
    lines.push(`@returns ${placeholder} (${unit.returns})`);
  lines.push(...tagLines(ex, placeholder));
  return lines;
}

export function scaffoldDocs(
  config: Config,
  extracted: ExtractedUnit[],
  options: ScaffoldOptions = {},
): ScaffoldResult {
  const placeholder = config.ids.placeholder;
  const result: ScaffoldResult = { edits: [] };
  const byFile = new Map<string, ExtractedUnit[]>();
  for (const ex of extracted) {
    if (options.unitFilter && ex.unit.id !== options.unitFilter && !ex.unit.id.startsWith(`${options.unitFilter}#`))
      continue;
    const needsDoc = ex.doc === undefined;
    const needsTags = ex.doc !== undefined && ex.unit.guarantees.length === 0;
    if (!needsDoc && !needsTags) continue;
    const list = byFile.get(ex.unit.file) ?? [];
    list.push(ex);
    byFile.set(ex.unit.file, list);
  }
  for (const [file, units] of byFile) {
    const abs = resolve(config.root, file);
    let text = readFileSync(abs, "utf8");
    // Apply from the bottom so earlier positions stay valid.
    const ordered = [...units].sort(
      (a, b) => b.declaration.getStart(b.sourceFile) - a.declaration.getStart(a.sourceFile),
    );
    for (const ex of ordered) {
      if (ex.docComment) {
        const indent = indentOf(text, ex.docComment.pos);
        const closing = text.indexOf("*/", ex.docComment.pos);
        if (closing < 0) continue;
        const insertion = tagLines(ex, placeholder)
          .map((l) => `${indent} * ${l}\n`)
          .join("");
        // Find the start of the line that holds `*/`.
        const lineStart = text.lastIndexOf("\n", closing) + 1;
        text = text.slice(0, lineStart) + insertion + text.slice(lineStart);
        result.edits.push({ file, unit: ex.unit.id, kind: "add-tags", text: insertion });
      } else {
        const start = ex.declaration.getStart(ex.sourceFile);
        const lineStart = text.lastIndexOf("\n", start - 1) + 1;
        const indent = indentOf(text, start);
        const block = [
          `${indent}/**`,
          ...fullDoc(ex, placeholder).map((l) => `${indent} * ${l}`),
          `${indent} */`,
          "",
        ].join("\n");
        text = text.slice(0, lineStart) + block + text.slice(lineStart);
        result.edits.push({ file, unit: ex.unit.id, kind: "insert-doc", text: block });
      }
    }
    if (!options.dryRun) writeFileSync(abs, text);
  }
  return result;
}
