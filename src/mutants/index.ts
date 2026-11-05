import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { ProgramHost } from "../extract/program.ts";
import type { Decision, Unit } from "../ir/schema.ts";
import { sha256 } from "../util/hash.ts";
import { relativeTo } from "../util/paths.ts";

/**
 * Value mutants (docs/design/0004-value-mutants.md): the value changes Stryker never makes,
 * chosen by specgate and applied by a runner outside the package.
 *
 * @remarks
 * specgate never runs tests. This module only lists changes: a number `n` → `n + 1`, a
 * non-empty string with a suffix, one element of a literal list, one single-line entry of a
 * module-level object literal, one plain-word alternative of a regex group removed. Sites are
 * the code a unit with guarantees owns, as the decision walk records it: the unit's lines, the
 * helpers it reaches, the module-level constants it reads and the collections it tests
 * membership in. Type positions, import specifiers, `typeof` comparisons, thrown messages,
 * property keys, directives and `console.*` arguments are skipped.
 */
export type ValueMutantKind = "number" | "string" | "element" | "entry" | "alternative";

export interface ValueMutant {
  /** `value-<n>`, in file and offset order; unique within one list */
  id: string;
  /** The unit the change is reported on (body, then helper, then collection, then constant) */
  unit: string;
  /** Module relative to root, POSIX separators */
  file: string;
  /** 1-based, for reporting */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Offsets in UTF-16 code units into the file's text; `original` is `text.slice(start, end)` */
  start: number;
  end: number;
  kind: ValueMutantKind;
  original: string;
  /** Text that takes the span's place (`""` for a removal) */
  replacement: string;
  /** The change in contract terms: "the default `initialValue` 0 → 1" */
  description: string;
  /** The unit's decision on the same value, when there is one */
  decision?: { kind: Decision["kind"]; values: string[] };
}

export interface ValueMutantList {
  schemaVersion: "1";
  tool: { name: string; version: string };
  /** sha256 of each file's text when the list was made */
  files: Record<string, { sha256: string }>;
  mutants: ValueMutant[];
}

type Place = "body" | "helper" | "collection" | "constant";
const PLACE_ORDER: Record<Place, number> = { body: 0, helper: 1, collection: 2, constant: 3 };

interface Region {
  unit: Unit;
  place: Place;
  line: number;
  endLine: number;
}

/** A change before it is attributed to a unit. */
interface Site {
  kind: ValueMutantKind;
  start: number;
  end: number;
  replacement: string;
  /** The value as a decision would hold it (`"413"`, `"Content-Length"`), for `decision` */
  value?: string;
  description: string;
}

/** The code each unit with guarantees owns, per file. */
function regionsOf(units: readonly Unit[]): Map<string, Region[]> {
  const out = new Map<string, Region[]>();
  const push = (file: string, r: Region): void => {
    out.set(file, [...(out.get(file) ?? []), r]);
  };
  for (const unit of units) {
    if (unit.guarantees.length === 0 || (unit.kind !== "function" && unit.kind !== "method")) continue;
    push(unit.file, { unit, place: "body", line: unit.line, endLine: unit.endLine });
    for (const h of unit.helperRanges ?? []) push(unit.file, { unit, place: "helper", ...h });
    for (const c of unit.constantRanges ?? [])
      push(c.file, { unit, place: "constant", line: c.line, endLine: c.endLine });
    for (const d of unit.decisions)
      if (d.kind === "member" && d.collection)
        push(d.collection.file, {
          unit,
          place: "collection",
          line: d.collection.line,
          endLine: d.collection.endLine,
        });
  }
  return out;
}

/**
 * Lists the value mutants of every unit with guarantees.
 * @returns The list `specgate mutants` writes, mutants sorted by file and offset.
 */
export function listValueMutants(
  units: readonly Unit[],
  host: ProgramHost,
  root: string,
  tool: { name: string; version: string },
): ValueMutantList {
  const regions = regionsOf(units);
  const files: ValueMutantList["files"] = {};
  const mutants: Array<Omit<ValueMutant, "id">> = [];
  for (const sf of host.files) {
    const file = relativeTo(root, sf.fileName);
    const fileRegions = regions.get(file);
    if (!fileRegions) continue;
    const text = sf.getFullText();
    let any = false;
    const seen = new Set<string>();
    for (const site of sitesOf(sf)) {
      const startPos = sf.getLineAndCharacterOfPosition(site.start);
      const endPos = sf.getLineAndCharacterOfPosition(site.end);
      const line = startPos.line + 1;
      const endLine = endPos.line + 1;
      const owner = fileRegions
        .filter((r) => line >= r.line && endLine <= r.endLine)
        .sort(
          (a, b) =>
            PLACE_ORDER[a.place] - PLACE_ORDER[b.place] ||
            a.endLine - a.line - (b.endLine - b.line) ||
            a.unit.id.localeCompare(b.unit.id),
        )[0];
      if (!owner) continue;
      const key = `${site.start}|${site.end}|${site.replacement}`;
      if (seen.has(key)) continue;
      seen.add(key);
      any = true;
      const decision = site.value !== undefined ? decisionFor(owner.unit, site, file, line) : undefined;
      mutants.push({
        unit: owner.unit.id,
        file,
        line,
        column: startPos.character + 1,
        endLine,
        endColumn: endPos.character + 1,
        start: site.start,
        end: site.end,
        kind: site.kind,
        original: text.slice(site.start, site.end),
        replacement: site.replacement,
        description: site.description,
        ...(decision ? { decision: { kind: decision.kind, values: decision.values } } : {}),
      });
    }
    if (any) files[file] = { sha256: sha256(text) };
  }
  mutants.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.end - b.end);
  return {
    schemaVersion: "1",
    tool: { ...tool },
    files,
    mutants: mutants.map((m, i) => ({ id: `value-${i + 1}`, ...m })),
  };
}

/** Writes `<dir>/mutants.json`. @returns The path written. */
export function writeValueMutants(list: ValueMutantList, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mutants.json");
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
  return path;
}

function decisionFor(unit: Unit, site: Site, file: string, line: number): Decision | undefined {
  const value = site.value;
  if (value === undefined) return undefined;
  if (site.kind === "element" || site.kind === "entry")
    return unit.decisions.find(
      (d) =>
        d.kind === "member" &&
        d.collection?.file === file &&
        line >= d.collection.line &&
        line <= d.collection.endLine &&
        d.values.includes(value),
    );
  return unit.decisions.find((d) => d.line === line && d.kind !== "member" && d.values.includes(value));
}

/** Every value site of a module, before attribution. */
function sitesOf(sf: ts.SourceFile): Site[] {
  const out: Site[] = [];
  /** `inMessage`: inside a `throw` or the arguments of `new …Error(…)`, where strings are wording */
  const visit = (node: ts.Node, inMessage: boolean): void => {
    if (isSkippedSubtree(node)) return;
    if (ts.isNumericLiteral(node) && !isSkippedLiteral(node) && !isLiteralListElement(node)) {
      const n = Number(node.text);
      const next = n + 1;
      if (Number.isFinite(next) && next !== n) {
        const negative = ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.MinusToken;
        const original = negative ? `-${node.getText(sf)}` : node.getText(sf);
        const changed = negative ? `-${String(next)}` : String(next);
        out.push({
          kind: "number",
          start: node.getStart(sf),
          end: node.getEnd(),
          replacement: String(next),
          value: String(negative ? -n : n),
          description: `${contextOf(negative ? node.parent : node, sf)}${original} → ${changed}`,
        });
      }
    }
    if (
      isStringLike(node) &&
      node.text.length > 0 &&
      !inMessage &&
      !isSkippedLiteral(node) &&
      !isLiteralListElement(node)
    ) {
      const raw = node.getText(sf);
      const changed = `${raw.slice(0, -1)}_x${raw.slice(-1)}`;
      out.push({
        kind: "string",
        start: node.getStart(sf),
        end: node.getEnd(),
        replacement: changed,
        value: node.text,
        description: `${contextOf(node, sf)}${shortened(raw)} → ${shortened(changed)}`,
      });
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2 && node.elements.every(isLiteralElement)) {
      const where = containerName(node, sf);
      node.elements.forEach((el, i) => {
        const span = removalSpan(node.elements, i, sf);
        const u = unwrap(el);
        out.push({
          kind: "element",
          ...span,
          replacement: "",
          ...(isStringLike(u) ? { value: u.text } : ts.isNumericLiteral(u) ? { value: String(Number(u.text)) } : {}),
          description: `\`${shortened(el.getText(sf))}\` removed from ${where}`,
        });
      });
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.length >= 2) {
      const owner = moduleConstOwner(node);
      if (owner) {
        node.properties.forEach((p, i) => {
          if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return;
          if (
            sf.getLineAndCharacterOfPosition(p.getStart(sf)).line !== sf.getLineAndCharacterOfPosition(p.getEnd()).line
          )
            return;
          const span = removalSpan(node.properties, i, sf);
          const key = p.name && !ts.isComputedPropertyName(p.name) ? propertyNameText(p.name) : undefined;
          out.push({
            kind: "entry",
            ...span,
            replacement: "",
            ...(key !== undefined ? { value: key } : {}),
            description: `\`${shortened(p.getText(sf))}\` removed from \`${owner}\``,
          });
        });
      }
    }
    if (ts.isRegularExpressionLiteral(node) && !isSkippedLiteral(node)) out.push(...alternativesOf(node, sf));
    const message =
      inMessage ||
      ts.isThrowStatement(node) ||
      (ts.isNewExpression(node) && /(?:Error|Exception)$/.test(node.expression.getText(sf)));
    ts.forEachChild(node, (child) => visit(child, message && !ts.isFunctionLike(child)));
  };
  visit(sf, false);
  return out;
}

/** One removal per plain-word alternative of each group: `/^(a|an|the)$/` gives three. */
function alternativesOf(node: ts.RegularExpressionLiteral, sf: ts.SourceFile): Site[] {
  const literal = node.getText(sf);
  const base = node.getStart(sf);
  const pattern = literal.slice(0, literal.lastIndexOf("/") + 1);
  const where = containerName(node, sf, `the regex \`${shortened(literal, 40)}\``);
  const out: Site[] = [];
  for (const m of pattern.matchAll(/(?<!\\)\((\?:)?((?:[\p{L}\p{N}_]+\|)+[\p{L}\p{N}_]+)\)/gu)) {
    const words = (m[2] ?? "").split("|");
    let offset = (m.index ?? 0) + 1 + (m[1]?.length ?? 0);
    words.forEach((word, i) => {
      const last = i === words.length - 1;
      // `word|` for every word but the last, `|word` for the last one.
      const start = base + (last ? offset - 1 : offset);
      const end = base + offset + word.length + (last ? 0 : 1);
      out.push({
        kind: "alternative",
        start,
        end,
        replacement: "",
        value: word,
        description: `\`${word}\` removed from ${where}`,
      });
      offset += word.length + 1;
    });
  }
  return out;
}

/**
 * The span that removes `items[i]` from a comma-separated list: the item up to the next item,
 * or, for the last one, from the end of the previous item (its comma included).
 */
function removalSpan(items: ts.NodeArray<ts.Node>, i: number, sf: ts.SourceFile): { start: number; end: number } {
  const item = items[i] as ts.Node;
  const next = items[i + 1];
  if (next) return { start: item.getStart(sf), end: next.getStart(sf) };
  const prev = items[i - 1] as ts.Node;
  return { start: prev.getEnd(), end: item.getEnd() };
}

/** "the default `initialValue` ", "`status` ", "" … */
function contextOf(node: ts.Node, sf: ts.SourceFile): string {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur.parent) ||
    ts.isAsExpression(cur.parent) ||
    ts.isSatisfiesExpression(cur.parent)
  )
    cur = cur.parent;
  const p = cur.parent;
  if ((ts.isParameter(p) || ts.isBindingElement(p)) && p.initializer === cur && ts.isIdentifier(p.name))
    return `the default \`${p.name.text}\` `;
  if (ts.isPropertyAssignment(p) && p.initializer === cur) {
    const key = propertyNameText(p.name);
    const owner = moduleConstOwner(p.parent);
    if (key !== undefined) return `\`${key}\`${owner && owner !== key ? ` in \`${owner}\`` : ""} `;
  }
  if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name)) return `\`${p.name.text}\` `;
  if (ts.isPropertyDeclaration(p) && p.initializer === cur) {
    const key = propertyNameText(p.name);
    if (key !== undefined) return `\`${key}\` `;
  }
  return `\`${shortened(p.getText(sf), 40)}\`: `;
}

/** `` `STR_SPLITTERS` `` for a list a `const` or property holds, else the list itself. */
function containerName(node: ts.Expression, sf: ts.SourceFile, fallback?: string): string {
  let cur: ts.Node = node;
  while (
    ts.isParenthesizedExpression(cur.parent) ||
    ts.isAsExpression(cur.parent) ||
    ts.isSatisfiesExpression(cur.parent) ||
    (ts.isNewExpression(cur.parent) &&
      ts.isIdentifier(cur.parent.expression) &&
      /^(?:Set|Map)$/.test(cur.parent.expression.text))
  )
    cur = cur.parent;
  const p = cur.parent;
  if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name)) return `\`${p.name.text}\``;
  if (ts.isPropertyAssignment(p) && p.initializer === cur) {
    const key = propertyNameText(p.name);
    if (key !== undefined) return `\`${key}\``;
  }
  return fallback ?? `the list \`${shortened(node.getText(sf), 40)}\``;
}

/** The name of the module-level `const` whose initializer holds `node` (not through a function). */
function moduleConstOwner(node: ts.Node): string | undefined {
  let cur: ts.Node = node;
  while (!ts.isSourceFile(cur)) {
    if (ts.isFunctionLike(cur) || ts.isClassLike(cur)) return undefined;
    if (ts.isVariableDeclaration(cur)) {
      const list = cur.parent;
      const statement = list.parent;
      return ts.isIdentifier(cur.name) &&
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isVariableStatement(statement) &&
        ts.isSourceFile(statement.parent)
        ? cur.name.text
        : undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Subtrees no change is made in: types, imports, exports, `console.*`, directives. */
function isSkippedSubtree(node: ts.Node): boolean {
  if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return true;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return true;
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
  )
    return true;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(callee) && callee.text === "require") return true;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "console"
    )
      return true;
  }
  // Directive prologues: "use strict", "use client".
  if (ts.isExpressionStatement(node) && isStringLike(node.expression)) return true;
  if (ts.isDecorator(node)) return true;
  return false;
}

/** A literal that is a key, a `typeof` operand or a test of a property's presence. */
function isSkippedLiteral(node: ts.Node): boolean {
  let cur = node;
  if (ts.isPrefixUnaryExpression(cur.parent)) cur = cur.parent;
  const p = cur.parent;
  if (ts.isComputedPropertyName(p)) return true;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isEnumMember(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p)) &&
    p.name === cur
  )
    return true;
  if (ts.isBindingElement(p) && p.propertyName === cur) return true;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (op === ts.SyntaxKind.InKeyword && p.left === cur) return true;
    if (
      (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken) &&
      (ts.isTypeOfExpression(unwrap(p.left)) || ts.isTypeOfExpression(unwrap(p.right)))
    )
      return true;
  }
  if (ts.isCaseClause(p) && p.expression === cur) {
    const sw = p.parent.parent;
    if (ts.isSwitchStatement(sw) && ts.isTypeOfExpression(unwrap(sw.expression))) return true;
  }
  if (ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return true;
  return false;
}

/** An element of a literal list: it gets the `element` change only. */
function isLiteralListElement(node: ts.Node): boolean {
  let cur = node;
  if (ts.isPrefixUnaryExpression(cur.parent)) cur = cur.parent;
  while (ts.isAsExpression(cur.parent) || ts.isParenthesizedExpression(cur.parent)) cur = cur.parent;
  const p = cur.parent;
  return ts.isArrayLiteralExpression(p) && p.elements.length >= 2 && p.elements.every(isLiteralElement);
}

function isLiteralElement(el: ts.Expression): boolean {
  const e = unwrap(el);
  return (
    isStringLike(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand))
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur))
    cur = cur.expression;
  return cur;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

function isStringLike(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function shortened(text: string, max = 50): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
