import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import type { ProgramHost } from "../extract/program.ts";
import { lineOf } from "../extract/program.ts";
import type { Decision, Unit } from "../ir/schema.ts";
import type { Mutant } from "../mutation/report.ts";
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
  /**
   * The code of every unit that owns the site: its lines and the helpers it reaches, in its own
   * file. A test that observes the change runs some of this code, so a runner can select tests
   * by what covers it when nothing covers the site itself (a module-level constant).
   */
  readers?: Reader[];
  /** Names of the module-level constants or collections the site is written in */
  names?: string[];
  /** Test files that reference the site's module-level constant directly */
  tests?: string[];
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
  /** The constant or collection, for `constant` and `collection` regions */
  name?: string;
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
  /** The node the change is made in */
  at: ts.Node;
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
      push(c.file, { unit, place: "constant", line: c.line, endLine: c.endLine, name: c.name });
    for (const d of unit.decisions)
      if (d.kind === "member" && d.collection)
        push(d.collection.file, {
          unit,
          place: "collection",
          line: d.collection.line,
          endLine: d.collection.endLine,
          name: d.collection.name,
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
  testFiles: readonly string[] = [],
): ValueMutantList {
  const regions = regionsOf(units);
  const references = referenceFinder(host, root, new Set(testFiles));
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
      const containing = fileRegions.filter((r) => line >= r.line && endLine <= r.endLine);
      const owner = [...containing].sort(
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
      // A site in a module-level constant runs at import; the code that reads the constant is what
      // a test exercises. Every reference in the program counts, not only the units with guarantees.
      const constant = moduleConstDeclaration(site.at);
      const refs = constant ? references.ofConstant(constant) : undefined;
      const fn = constant ? undefined : outermostFunction(site.at);
      const ofFn = fn ? references.ofFunction(fn, sf) : undefined;
      const readers = refs ? refs.readers : ofFn ? [ofFn.reader] : readersOf(containing);
      const siteTests = refs?.tests ?? ofFn?.tests ?? [];
      const names = [...new Set(containing.flatMap((r) => (r.name !== undefined ? [r.name] : [])))].sort();
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
        ...(readers ? { readers } : {}),
        ...(names.length > 0 ? { names } : {}),
        ...(siteTests.length > 0 ? { tests: siteTests } : {}),
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

/** A function that reads a site, and, when they can be traced, the functions that call it. */
export interface Reader {
  file: string;
  line: number;
  endLine: number;
  /**
   * The outermost functions that reference this one by name (transitively, three levels). Absent
   * when the function has no name to trace (a method, a callback) or some reference to it is not
   * inside a function; a runner then cannot reach the tests that run it through its callers.
   */
  callers?: Reader[];
}

interface References {
  /** Outermost functions that read the name; `undefined` when some reference is not in one */
  readers: Reader[] | undefined;
  tests: string[];
}

const CALLER_DEPTH = 3;

/**
 * Finds every place the program reads a declared name: the outermost function around each
 * reference (in any project file), and the test files that name it. A reference in a
 * module-level constant is followed into that constant's references; any other reference outside
 * a function (a module-level statement) leaves the readers unknown. Each reader that is a named
 * function gets its own callers the same way, so a runner can reach the tests of code that a
 * coverage report does not cover.
 */
function referenceFinder(
  host: ProgramHost,
  root: string,
  testFiles: ReadonlySet<string>,
): {
  ofConstant: (decl: ts.VariableDeclaration) => References;
  ofFunction: (fn: ts.Node, sf: ts.SourceFile) => { reader: Reader; tests: string[] };
} {
  const cache = new Map<ts.Symbol, References>();
  const checker = host.checker;
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    const parent = node.parent;
    let sym =
      parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym;
  };
  const find = (name: ts.Identifier, owner: ts.Node, depth: number): References => {
    const target = symbolOf(name);
    if (!target) return { readers: undefined, tests: [] };
    const cached = cache.get(target);
    if (cached) return cached;
    // In progress: a cycle (mutually recursive helpers) sees "unknown", so a runner falls back.
    const result: References = { readers: undefined, tests: [] };
    cache.set(target, result);
    const readers = new Map<string, Reader>();
    const fnNodes = new Map<string, { fn: ts.Node; sf: ts.SourceFile }>();
    const tests = new Set<string>();
    let complete = true;
    for (const sf of host.program.getSourceFiles()) {
      if (sf.isDeclarationFile || /[\\/]node_modules[\\/]/.test(sf.fileName) || !sf.text.includes(name.text)) continue;
      const file = relativeTo(root, sf.fileName);
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          node.text === name.text &&
          node !== name &&
          !ts.isImportSpecifier(node.parent) &&
          !ts.isExportSpecifier(node.parent) &&
          !ts.isImportClause(node.parent) &&
          !inTypePosition(node) &&
          !isWithin(node, owner) &&
          symbolOf(node) === target
        ) {
          if (testFiles.has(file)) tests.add(file);
          else {
            const fn = outermostFunction(node);
            if (fn) {
              const line = lineOf(sf, fn.getStart(sf));
              const key = `${file}:${line}`;
              if (!readers.has(key)) {
                readers.set(key, { file, line, endLine: lineOf(sf, fn.getEnd()) });
                fnNodes.set(key, { fn, sf });
              }
            } else {
              const inner = moduleConstDeclaration(node);
              const nested =
                inner && ts.isIdentifier(inner.name) && depth < CALLER_DEPTH
                  ? find(inner.name, inner, depth + 1)
                  : undefined;
              if (!nested?.readers) complete = false;
              else {
                for (const r of nested.readers) readers.set(`${r.file}:${r.line}`, r);
                for (const t of nested.tests) tests.add(t);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    // Callers of each reader, so the tests that run it can be found when nothing covers it.
    if (depth < CALLER_DEPTH)
      for (const [key, { fn }] of fnNodes) {
        const fnName = functionName(fn);
        const reader = readers.get(key);
        if (!fnName || !reader) continue;
        const callers = find(fnName, fn, depth + 1);
        if (callers.readers) reader.callers = callers.readers;
        for (const t of callers.tests) tests.add(t);
      }
    result.readers = complete
      ? [...readers.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      : undefined;
    result.tests = [...tests].sort();
    return result;
  };
  return {
    ofConstant: (decl) => (ts.isIdentifier(decl.name) ? find(decl.name, decl, 0) : { readers: undefined, tests: [] }),
    // The function around a site, with its callers when it has a name to trace them by.
    ofFunction: (fn, sf) => {
      const reader: Reader = {
        file: relativeTo(root, sf.fileName),
        line: lineOf(sf, fn.getStart(sf)),
        endLine: lineOf(sf, fn.getEnd()),
      };
      const name = functionName(fn);
      if (!name) return { reader, tests: [] };
      const callers = find(name, fn, 1);
      return { reader: callers.readers ? { ...reader, callers: callers.readers } : reader, tests: callers.tests };
    },
  };
}

/** Whether `node` lies inside `owner` (a reference of a function to itself). */
function isWithin(node: ts.Node, owner: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) if (cur === owner) return true;
  return false;
}

/** The name a function is called by: its declaration name, or the module-level `const` holding it. */
function functionName(fn: ts.Node): ts.Identifier | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && p.initializer === fn && ts.isIdentifier(p.name)) return p.name;
  return undefined;
}

/** Under a type node (`typeof X`, `keyof typeof X`): names the constant's type, reads no value. */
function inTypePosition(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent)
    if (ts.isTypeNode(cur) && !ts.isExpressionWithTypeArguments(cur)) return true;
  return false;
}

/** The outermost function, method or accessor around a node, below the module level. */
function outermostFunction(node: ts.Node): ts.Node | undefined {
  let found: ts.Node | undefined;
  for (let cur: ts.Node | undefined = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent)
    if (ts.isFunctionLike(cur)) found = cur;
  return found;
}

/** The module-level `const` declaration whose initializer holds `node` (not through a function). */
function moduleConstDeclaration(node: ts.Node): ts.VariableDeclaration | undefined {
  for (let cur: ts.Node = node; !ts.isSourceFile(cur); cur = cur.parent) {
    if (ts.isFunctionLike(cur) || ts.isClassLike(cur)) return undefined;
    if (ts.isVariableDeclaration(cur)) {
      const list = cur.parent;
      return ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isVariableStatement(list.parent) &&
        ts.isSourceFile(list.parent.parent)
        ? cur
        : undefined;
    }
  }
  return undefined;
}

/** The lines and helpers, in their own files, of every unit owning one of the regions. */
function readersOf(regions: readonly Region[]): Reader[] {
  const seen = new Set<string>();
  const out: Reader[] = [];
  for (const unit of new Set(regions.map((r) => r.unit)))
    for (const r of [{ line: unit.line, endLine: unit.endLine }, ...(unit.helperRanges ?? [])]) {
      const key = `${unit.file}:${r.line}:${r.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: unit.file, line: r.line, endLine: r.endLine });
    }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.endLine - b.endLine);
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
  // A regex alternative is a member of the regex (`decisions.widen`), as an element is of its list.
  if (site.kind === "element" || site.kind === "entry" || site.kind === "alternative")
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

/** A value change a value report says the tests caught, with the value it changed. */
interface KilledValue {
  kind: ValueMutantKind;
  line: number;
  value: string;
}

/**
 * Which decisions a value report (#60) confirms: a decision is confirmed when, for each of its
 * values, a `Value` mutant changing that value was caught by the tests (#61). A `member` is
 * confirmed by the removal of its element, entry or regex alternative within its collection's
 * lines; any other decision by a number or string change on its own line.
 *
 * @remarks
 * A report mutant is matched to the site `specgate mutants` would list today by file, line and
 * column, and by its description when the report gives one. A report made from other sources
 * (stale) matches nothing and confirms nothing.
 * @param caught - The report's `Value` mutants whose status counts as detected.
 */
export function valueMeasurement(
  caught: readonly Mutant[],
  host: ProgramHost,
  root: string,
): (unit: Unit, decision: Decision) => boolean {
  const byFile = new Map<string, KilledValue[]>();
  const wanted = new Map<string, Mutant[]>();
  for (const m of caught) if (m.column !== undefined) wanted.set(m.file, [...(wanted.get(m.file) ?? []), m]);
  for (const [file, mutants] of wanted) {
    const sf = host.program.getSourceFile(resolve(root, file));
    if (!sf) continue;
    const sites = new Map<string, Site>();
    for (const site of sitesOf(sf)) {
      const pos = sf.getLineAndCharacterOfPosition(site.start);
      sites.set(`${pos.line + 1}:${pos.character + 1}`, site);
    }
    const out: KilledValue[] = [];
    for (const m of mutants) {
      const site = sites.get(`${m.line}:${m.column}`);
      if (!site || site.value === undefined) continue;
      if (m.description !== undefined && m.description !== site.description) continue;
      out.push({ kind: site.kind, line: m.line, value: site.value });
    }
    byFile.set(file, out);
  }
  if (byFile.size === 0) return () => false;
  return (unit, d) => {
    if (d.kind === "member") {
      const c = d.collection;
      const value = d.values[0];
      if (!c || value === undefined) return false;
      return (byFile.get(c.file) ?? []).some(
        (k) =>
          (k.kind === "element" || k.kind === "entry" || k.kind === "alternative") &&
          k.value === value &&
          k.line >= c.line &&
          k.line <= c.endLine,
      );
    }
    const kills = (byFile.get(unit.file) ?? []).filter(
      (k) => (k.kind === "number" || k.kind === "string") && k.line === d.line,
    );
    return d.values.length > 0 && d.values.every((v) => kills.some((k) => k.value === v));
  };
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
          at: node,
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
        at: node,
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
          at: node,
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
            at: node,
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
        at: node,
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
