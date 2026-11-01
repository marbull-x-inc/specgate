import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Config, TestAdapter } from "../../config/schema.ts";
import type { TestCase } from "../../ir/schema.ts";
import { textHash } from "../../util/hash.ts";
import { relativeTo } from "../../util/paths.ts";

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
  return undefined;
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
  const idPattern = new RegExp(config.ids.pattern);
  const describePatterns = config.tests.describeOperationPatterns.map((p) => new RegExp(p));
  const prefixes = Object.values(config.tests.prefixes);
  const tests: TestCase[] = [];
  const unlinked: TestExtraction["unlinked"] = [];

  for (const file of files) {
    if (config.tests.generatedSuffixes.some((s) => file.endsWith(s))) continue;
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const relFile = relativeTo(config.root, file);
    const reqIds = requirementIds(text.slice(0, 2000), config);
    const stack: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const parts = calleeParts(node.expression);
        const head = parts?.[0];
        const isPlaywrightDescribe = adapter === "playwright" && parts?.[0] === "test" && parts[1] === "describe";
        if (parts && head && (DESCRIBE_CALLEES.has(head) || isPlaywrightDescribe)) {
          const title = titleOf(node.arguments[0]);
          const callback = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
          stack.push(title ?? "");
          if (callback) ts.forEachChild(callback, visit);
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
                : modifier === "skip"
                  ? "skip"
                  : modifier === "each" || ts.isCallExpression(node.expression)
                    ? "each"
                    : "test";
            const body = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
            const bodyHash = textHash(body ? body.getText(sf) : "");
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
              tests.push({
                key: unitId ? `${unitId}.${match.id}` : match.id,
                ...(unitId ? { unitId } : {}),
                guaranteeId: match.id,
                file: relFile,
                line,
                title,
                status,
                bodyHash,
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
