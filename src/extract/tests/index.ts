import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { Config, TestAdapter } from "../../config/schema.ts";
import type { TestCase } from "../../ir/schema.ts";
import { textHash } from "../../util/hash.ts";
import { fileExists, relativeTo } from "../../util/paths.ts";

/**
 * Reads test titles and maps them to guarantee keys.
 *
 * @remarks
 * All supported runners (bun test, vitest, jest, Playwright) share the `describe` / `test` /
 * `it` call shape, so one syntax walker serves every adapter; the adapter only changes which
 * identifiers count (`test.describe` for Playwright) and what `gen` emits. Linking is by title
 * alone: a test names the guarantee it covers as `Target#operation.<id>`, or as `<id>` when the
 * enclosing `describe` titles already name the target and operation. Runner internals, tags or
 * annotations are deliberately not used so that the same convention works everywhere.
 */
export interface TestExtraction {
  tests: TestCase[];
  /** Tests whose title names no guarantee key at all (informational). */
  unlinked: Array<{ file: string; line: number; title: string }>;
}

const TEST_CALLEES = new Set(["test", "it"]);
const DESCRIBE_CALLEES = new Set(["describe", "suite"]);

function calleeParts(expr: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = calleeParts(expr.expression);
    return inner ? [...inner, expr.name.text] : undefined;
  }
  if (ts.isCallExpression(expr)) return calleeParts(expr.expression); // test.each([...])(title, fn)
  if (ts.isTaggedTemplateExpression(expr)) return calleeParts(expr.tag); // test.each`table`(title, fn)
  return undefined;
}

/** The table of `test.each([...])(…)` / `test.each\`…\`(…)`: what its rows are written in. */
function eachTables(callee: ts.Expression): ts.Node[] {
  if (ts.isCallExpression(callee)) return [...callee.arguments];
  if (ts.isTaggedTemplateExpression(callee)) return [callee.template];
  return [];
}

function titleOf(arg: ts.Expression | undefined): string | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg))
    return [arg.head.text, ...arg.templateSpans.map((s) => `\${}${s.literal.text}`)].join("");
  return undefined;
}

export interface TitleMatch {
  target: string | undefined;
  operation: string | undefined;
  id: string;
}

/** Parses "Target#op.ok.x rest", "op.ok.x rest", "#op.ok.x" or "ok.x rest" against the id pattern. */
/**
 * Removes a configured category prefix (`正常系:` …) from the start of a title so that the
 * guarantee key may follow it. Repositories that enforce such prefixes keep their rule; the
 * core only knows the strings from `tests.prefixes`.
 */
export function stripTitlePrefix(title: string, prefixes: readonly string[]): string {
  const trimmed = title.trimStart();
  for (const prefix of [...prefixes].filter((p) => p.length > 0).sort((a, b) => b.length - a.length)) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trimStart();
  }
  return trimmed;
}

export function matchTitle(title: string, idPattern: RegExp): TitleMatch | undefined {
  const head = title.trim().split(/\s+/)[0] ?? "";
  // Longest-first: try to split head into [qualifier].[id] where id matches the pattern.
  const parts = head.split(".");
  for (let i = 0; i < parts.length; i++) {
    const qualifier = parts.slice(0, i).join(".");
    const id = parts.slice(i).join(".");
    if (!id || !idPattern.test(id)) continue;
    if (qualifier === "") return { target: undefined, operation: undefined, id };
    const hash = qualifier.indexOf("#");
    if (hash >= 0) {
      const target = qualifier.slice(0, hash) || undefined;
      const operation = qualifier.slice(hash + 1) || undefined;
      if (/^[\w$]*$/.test(target ?? "") && /^[\w$]+$/.test(operation ?? "")) return { target, operation, id };
      continue;
    }
    if (/^[\w$]+$/.test(qualifier)) return { target: undefined, operation: qualifier, id };
  }
  return undefined;
}

function describeContext(
  stack: readonly string[],
  patterns: readonly RegExp[],
): { target: string | undefined; operation: string | undefined } {
  let target: string | undefined;
  let operation: string | undefined;
  for (const title of stack) {
    const trimmed = title.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && target === undefined) {
      target = trimmed;
      continue;
    }
    for (const pattern of patterns) {
      const m = pattern.exec(trimmed);
      if (m?.[1]) {
        operation = m[1];
        break;
      }
    }
  }
  return { target, operation };
}

function requirementIds(text: string, config: Config): string[] {
  if (!config.requirementHeader.enabled) return [];
  const re = new RegExp(config.requirementHeader.pattern, "gm");
  const ids: string[] = [];
  for (const m of text.matchAll(re)) if (m[1]) ids.push(m[1]);
  return ids;
}

export function extractTests(
  config: Config,
  files: readonly string[],
  adapter: TestAdapter = config.tests.adapter,
): TestExtraction {
  moduleCache.clear();
  const idPattern = new RegExp(config.ids.pattern);
  const describePatterns = config.tests.describeOperationPatterns.map((p) => new RegExp(p));
  const prefixes = [...Object.values(config.tests.prefixes), ...config.tests.titlePrefixes];
  const tests: TestCase[] = [];
  const unlinked: TestExtraction["unlinked"] = [];

  for (const file of files) {
    if (config.tests.generatedSuffixes.some((s) => file.endsWith(s))) continue;
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const relFile = relativeTo(config.root, file);
    const reqIds = requirementIds(text.slice(0, 2000), config);
    const stack: string[] = [];
    const describeTables: ts.Node[] = [];
    const scope = testFileScope(sf, file, config.root);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const parts = calleeParts(node.expression);
        const head = parts?.[0];
        const isPlaywrightDescribe = adapter === "playwright" && parts?.[0] === "test" && parts[1] === "describe";
        if (parts && head && (DESCRIBE_CALLEES.has(head) || isPlaywrightDescribe)) {
          const title = titleOf(node.arguments[0]);
          const callback = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
          stack.push(title ?? "");
          const tables = eachTables(node.expression);
          describeTables.push(...tables);
          if (callback) ts.forEachChild(callback, visit);
          describeTables.length -= tables.length;
          stack.pop();
          return;
        }
        if (parts && head && TEST_CALLEES.has(head) && !(adapter === "playwright" && parts[1] === "describe")) {
          const title = titleOf(node.arguments[0]);
          if (title !== undefined) {
            const modifier = parts[1];
            const status: TestCase["status"] =
              modifier === "todo"
                ? "todo"
                : modifier === "failing" || modifier === "fails"
                  ? "failing"
                  : modifier === "skip"
                    ? "skip"
                    : modifier === "each" || ts.isCallExpression(node.expression)
                      ? "each"
                      : "test";
            const body = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
            const bodyHash = textHash(body ? body.getText(sf) : "");
            const tables = [...eachTables(node.expression), ...describeTables];
            const used = usedValues(scope, body ? [body, ...tables] : tables, tables, config.tests.literalLimit);
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            const match = matchTitle(stripTitlePrefix(title, prefixes), idPattern);
            if (match) {
              const context = describeContext(stack, describePatterns);
              // "op.id" names a free function unless an enclosing describe names a different target (a class).
              const operation = match.operation ?? context.operation;
              const target =
                match.target ??
                (context.target !== undefined && context.target !== operation ? context.target : undefined);
              const unitId = operation ? (target ? `${target}#${operation}` : operation) : target;
              // A lone kind word ("ok", "err") with nothing to qualify it is ordinary prose, not a key.
              if (unitId === undefined && !match.id.includes(".")) {
                unlinked.push({ file: relFile, line, title });
                return;
              }
              tests.push({
                key: unitId ? `${unitId}.${match.id}` : match.id,
                ...(unitId ? { unitId } : {}),
                guaranteeId: match.id,
                file: relFile,
                line,
                title,
                status,
                bodyHash,
                literals: used.literals,
                keys: used.keys,
                iterates: used.iterates,
                ...(used.builds.length > 0 ? { builds: used.builds } : {}),
                requirementIds: reqIds,
              });
            } else {
              unlinked.push({ file: relFile, line, title });
            }
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { tests, unlinked };
}

interface TestFileScope {
  /** Module-level `const` initialisers of the test file, by name */
  consts: ReadonlyMap<string, ts.Expression>;
  /** Imported local name → exported name and the module it comes from */
  imports: ReadonlyMap<string, { name: string; from: string }>;
  /** Repository root, to read the modules imports resolve to */
  root: string;
}

function testFileScope(sf: ts.SourceFile, file: string, root: string): TestFileScope {
  const consts = new Map<string, ts.Expression>();
  const imports = new Map<string, { name: string; from: string }>();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    }
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const from = moduleFile(st.moduleSpecifier.text, file, root);
      const bindings = st.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const el of bindings.elements)
          imports.set(el.name.text, { name: (el.propertyName ?? el.name).text, from });
    }
  }
  return { consts, imports, root };
}

/**
 * The file a relative import resolves to (relative to root), tried with the extensions a
 * TypeScript project uses; a bare or aliased specifier is returned as written.
 */
function moduleFile(specifier: string, file: string, root: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const base = resolve(dirname(file), specifier);
  const stem = base.replace(/\.(?:m|c)?js$/, "");
  for (const candidate of [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (/\.(?:m|c)?tsx?$/.test(candidate) && fileExists(candidate)) return relativeTo(root, candidate);
  }
  return specifier;
}

const ITERATING_METHODS = new Set(["forEach", "map", "flatMap", "every", "some", "filter"]);

/**
 * The literal values and object keys a test uses, and the imported constants it iterates.
 *
 * @remarks
 * A value counts as used when it is written in the test body or its `each` tables, or in a
 * module-level `const` of the same test file that they reference by name (one hop, so a
 * fixture `const paths = [...]` counts). The test title is not a source: it describes the test,
 * it does not exercise anything. Iterating an imported constant (`it.each(LIST)`,
 * `for (const x of LIST)`) is recorded separately: such a test covers whatever the constant
 * holds, so it cannot fail when an element is removed.
 */
function usedValues(
  scope: TestFileScope,
  roots: readonly ts.Node[],
  tables: readonly ts.Node[],
  limit: number,
): {
  literals: string[];
  keys: string[];
  iterates: Array<{ name: string; from: string }>;
  builds: Array<{ name: string; from: string; literals: string[] }>;
} {
  const literals = new Set<string>();
  const builds = new Map<string, { name: string; from: string }>();
  const keys = new Set<string>();
  const iterates = new Map<string, { name: string; from: string }>();
  const followed = new Set<string>();
  const add = (value: string): void => {
    if (literals.size < limit) literals.add(value);
  };
  const iterated = (expr: ts.Expression): void => {
    let e = expr;
    // Object.keys(X) / Object.values(X) / Object.entries(X)
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      ts.isIdentifier(e.expression.expression) &&
      e.expression.expression.text === "Object" &&
      e.arguments[0]
    )
      e = e.arguments[0];
    if (!ts.isIdentifier(e)) return;
    const imported = scope.imports.get(e.text);
    if (imported) iterates.set(`${imported.from}#${imported.name}`, imported);
  };
  const walk = (n: ts.Node, hop: boolean): void => {
    // Object keys: a test pins `claim === "iss"` by writing `{ iss: … }`.
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isMethodDeclaration(n)) &&
      ts.isObjectLiteralExpression(n.parent) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) || ts.isNoSubstitutionTemplateLiteral(n.name)) &&
      n.name.text.length > 0 &&
      keys.size < limit
    )
      keys.add(n.name.text);
    // A call to an imported function of the project builds an input (`toTargetHref(APP, true)`).
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const imported = scope.imports.get(n.expression.text);
      if (imported && RESOLVED_MODULE.test(imported.from)) builds.set(`${imported.from}#${imported.name}`, imported);
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.length > 0) add(n.text);
    else if (ts.isTemplateExpression(n)) {
      for (const part of [n.head.text, ...n.templateSpans.map((t) => t.literal.text)])
        if (/[\p{L}\p{N}]/u.test(part)) add(part);
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      // parts are read from the enclosing template expression
    } else if (ts.isNumericLiteral(n)) {
      const value = Number(n.text);
      if (value !== 0 && value !== 1 && value !== -1) add(String(value));
    } else if (ts.isIdentifier(n) && hop && !followed.has(n.text)) {
      const init = scope.consts.get(n.text);
      if (init) {
        followed.add(n.text);
        walk(init, false);
      }
    }
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) {
      const value = -Number(n.operand.text);
      if (value !== -1) add(String(value));
    }
    if (ts.isForOfStatement(n)) iterated(n.expression);
    // Expected values derived from the constant: new Set(X), new Map(X), Array.from(X), [...X]
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.expression.text === "Set" || n.expression.text === "Map") &&
      n.arguments?.[0]
    )
      iterated(n.arguments[0]);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Array" &&
      n.expression.name.text === "from" &&
      n.arguments[0]
    )
      iterated(n.arguments[0]);
    if (ts.isSpreadElement(n) && ts.isArrayLiteralExpression(n.parent)) iterated(n.expression);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ITERATING_METHODS.has(n.expression.name.text)
    )
      iterated(n.expression.expression);
    ts.forEachChild(n, (c) => walk(c, hop));
  };
  for (const root of roots) walk(root, true);
  for (const table of tables) if (ts.isExpression(table)) iterated(table);
  return {
    literals: [...literals],
    keys: [...keys],
    iterates: [...iterates.values()],
    builds: [...builds.values()].map((b) => ({ ...b, literals: functionLiterals(scope.root, b.from, b.name, limit) })),
  };
}

const RESOLVED_MODULE = /\.(?:m|c)?tsx?$/;
const moduleCache = new Map<string, ts.SourceFile | undefined>();

/**
 * The string literals, template parts and non-trivial numbers in the body of a function exported
 * by a project module (`export function f` or `export const f = () => …`). A test that builds its
 * input with it gets these values from the implementation's side, not from its own text.
 */
function functionLiterals(root: string, from: string, name: string, limit: number): string[] {
  const path = resolve(root, from);
  if (!moduleCache.has(path)) {
    let sf: ts.SourceFile | undefined;
    try {
      sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    } catch {
      sf = undefined;
    }
    moduleCache.set(path, sf);
  }
  const sf = moduleCache.get(path);
  if (!sf) return [];
  let body: ts.Node | undefined;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) body = st.body;
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        )
          body = d.initializer.body;
  }
  if (!body) return [];
  const out = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (out.size >= limit) return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.length > 0) out.add(n.text);
    else if (ts.isTemplateExpression(n)) {
      for (const part of [n.head.text, ...n.templateSpans.map((t) => t.literal.text)])
        if (/[\p{L}\p{N}]/u.test(part)) out.add(part);
    } else if (ts.isNumericLiteral(n)) {
      const value = Number(n.text);
      if (value !== 0 && value !== 1 && value !== -1) out.add(String(value));
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return [...out];
}
