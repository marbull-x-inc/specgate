import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config/schema.ts";
import type { ExtractedUnit } from "../extract/surface.ts";

/**
 * Writes TSDoc skeletons for units that have no doc comment or no guarantee tags.
 *
 * @remarks
 * Only signature-derived facts are filled in: parameter names and types, the return type,
 * error classes thrown in the body, and the ports the body calls. The wording of guarantees is
 * a design decision, so it is left as the configured placeholder for a person (or an AI
 * assistant outside this tool) to write. `check` reports the placeholders until they are.
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
  for (const err of ex.thrownErrorTypes)
    lines.push(`@throws {@link ${err}} ${placeholder} condition under which ${err} is thrown`);
  if (usedPorts.length > 0) lines.push(`@uses ${usedPorts.join(", ")}`);
  if (usedPorts.length > 0) lines.push(`@modifies ${placeholder}`);
  lines.push(
    `@guarantee ${placeholder} what holds after a successful call, in terms of params, result and declared ports (replace ${placeholder} with an id; list the ports whose state changes in the modifies tag, or drop that tag)`,
  );
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
