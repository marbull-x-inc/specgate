import ts from "typescript";
import type { Decision, DecisionKind } from "../ir/schema.ts";
import { lineOf, type ProgramHost } from "./program.ts";

/**
 * Collects the places where an operation's implementation commits to a concrete value: a
 * boundary it compares against, a constant it computes with, a string it outputs, a value it
 * matches its input against.
 *
 * @remarks
 * A test can only pin down a value the contract names. When the implementation decides on
 * `86400000` or `"year"` and no guarantee or example mentions it, every test written from the
 * contract passes whether that value is right or wrong — the gate is green while the decision
 * is untested. These points let the `decision-unspecified` rule report such holes statically,
 * without running a single test.
 *
 * The walk follows what belongs to the operation: private helpers reached through `this.x()`
 * and non-exported functions of the same module called by name (transitively, cycle-safe).
 * Exported functions are units of their own and keep their own decisions.
 *
 * Deliberately not collected: `0`, `1`, `-1` and empty strings (too generic to be a decision),
 * `typeof` checks (the signature already states the accepted types), comparisons between two
 * non-constant expressions, and messages passed to `new …Error(...)` / `new …Exception(...)`.
 */
export function collectDecisions(
  body: ts.Node,
  sf: ts.SourceFile,
  host: ProgramHost,
  helpers: ReadonlyMap<string, ts.Node> = new Map(),
): Decision[] {
  const out: Decision[] = [];
  const seen = new Set<string>();
  const visitedBodies = new Set<ts.Node>();
  const recordedConstants = new Set<ts.Node>();

  const add = (kind: DecisionKind, node: ts.Node, values: string[], names: string[]): void => {
    if (values.length === 0) return;
    const key = `${kind}|${values.join("|")}|${names.join("|")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, expression: oneLine(node.getText(sf)), line: lineOf(sf, node.getStart(sf)), values, names });
  };

  const constDeclarationOf = (node: ts.Expression): ts.VariableDeclaration | undefined => {
    if (!ts.isIdentifier(node)) return undefined;
    for (const d of host.declarationsOf(node)) {
      if (
        ts.isVariableDeclaration(d) &&
        d.initializer &&
        ts.isVariableDeclarationList(d.parent) &&
        (d.parent.flags & ts.NodeFlags.Const) !== 0
      )
        return d;
    }
    return undefined;
  };

  const evaluate = (node: ts.Expression, depth = 0): number | undefined => {
    if (depth > 20) return undefined;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, depth + 1);
    if (ts.isPrefixUnaryExpression(node)) {
      const v = evaluate(node.operand, depth + 1);
      if (v === undefined) return undefined;
      if (node.operator === ts.SyntaxKind.MinusToken) return -v;
      if (node.operator === ts.SyntaxKind.PlusToken) return v;
      return undefined;
    }
    if (ts.isBinaryExpression(node)) {
      const l = evaluate(node.left, depth + 1);
      const r = evaluate(node.right, depth + 1);
      if (l === undefined || r === undefined) return undefined;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return l + r;
        case ts.SyntaxKind.MinusToken:
          return l - r;
        case ts.SyntaxKind.AsteriskToken:
          return l * r;
        case ts.SyntaxKind.SlashToken:
          return l / r;
        case ts.SyntaxKind.PercentToken:
          return l % r;
        case ts.SyntaxKind.AsteriskAsteriskToken:
          return l ** r;
        default:
          return undefined;
      }
    }
    const decl = constDeclarationOf(node);
    if (decl?.initializer) return evaluate(decl.initializer, depth + 1);
    return undefined;
  };

  /** Records a same-module numeric constant (and the constants it is computed from). */
  const recordConstant = (decl: ts.VariableDeclaration): void => {
    if (recordedConstants.has(decl) || decl.getSourceFile() !== sf || !decl.initializer) return;
    recordedConstants.add(decl);
    const value = evaluate(decl.initializer);
    if (value === undefined) return;
    const literals: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isNumericLiteral(n) && !isTrivialNumber(Number(n.text))) literals.push(numberText(Number(n.text)));
      if (ts.isIdentifier(n)) {
        const inner = constDeclarationOf(n);
        if (inner) recordConstant(inner);
      }
      ts.forEachChild(n, walk);
    };
    walk(decl.initializer);
    // The factors (`7` in `d * 7`) are too common to count as naming the constant; only the
    // value it evaluates to or its name does.
    if (isTrivialNumber(value) && literals.length === 0) return;
    add("constant", decl, [numberText(value)], [decl.name.getText(sf)]);
  };

  const sideValue = (side: ts.Expression): { value: number; names: string[] } | undefined => {
    const value = evaluate(side);
    if (value === undefined) return undefined;
    return { value, names: ts.isIdentifier(side) ? [side.text] : [] };
  };

  const isTypeofSide = (side: ts.Expression): boolean => ts.isTypeOfExpression(side);

  const visit = (node: ts.Node, inReturn: boolean): void => {
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const decl = constDeclarationOf(node);
      if (decl) recordConstant(decl);
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken
      ) {
        const l = sideValue(node.left);
        const r = sideValue(node.right);
        const constant = l && !r ? l : r && !l ? r : undefined;
        if (constant && !isTrivialNumber(constant.value))
          add("boundary", node, [numberText(constant.value)], constant.names);
      } else if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        if (!isTypeofSide(node.left) && !isTypeofSide(node.right)) {
          for (const side of [node.left, node.right]) {
            if (isStringLike(side) && side.text.length > 0) add("match", node, [side.text], []);
            else {
              const v = sideValue(side);
              if (v && !isTrivialNumber(v.value)) add("match", node, [numberText(v.value)], v.names);
            }
          }
        }
      } else if (
        op === ts.SyntaxKind.AsteriskToken ||
        op === ts.SyntaxKind.SlashToken ||
        op === ts.SyntaxKind.PercentToken ||
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.MinusToken
      ) {
        for (const side of [node.left, node.right]) {
          if (ts.isNumericLiteral(side) && !isTrivialNumber(Number(side.text)))
            add("constant", node, [numberText(Number(side.text))], []);
        }
      }
    }

    if (ts.isCaseClause(node)) {
      const e = node.expression;
      if (isStringLike(e) && e.text.length > 0) add("match", node.expression, [e.text], []);
      else if (ts.isNumericLiteral(e) && !isTrivialNumber(Number(e.text)))
        add("match", node.expression, [numberText(Number(e.text))], []);
    }

    if (inReturn && !isPropertyKey(node) && !isOperandOfTest(node) && !isErrorMessage(node)) {
      if (isStringLike(node) && hasWordCharacter(node.text)) add("output", node, [node.text], []);
      if (ts.isTemplateExpression(node)) {
        const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]
          .map((p) => p.trim())
          .filter(hasWordCharacter);
        if (parts.length > 0) add("output", node, unique(parts), []);
      }
    }

    // Follow what belongs to this operation.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
        helpers.has(callee.name.text)
      ) {
        const helperBody = helpers.get(callee.name.text);
        if (helperBody && !visitedBodies.has(helperBody)) {
          visitedBodies.add(helperBody);
          visit(helperBody, false);
        }
      } else if (ts.isIdentifier(callee)) {
        for (const decl of host.declarationsOf(callee)) {
          const local = localFunctionBody(decl, sf);
          if (local && !visitedBodies.has(local)) {
            visitedBodies.add(local);
            visit(local, false);
          }
        }
      }
    }

    const childInReturn = inReturn || ts.isReturnStatement(node) || isConciseArrowBody(node);
    ts.forEachChild(node, (child) => {
      // A nested function's return is the nested function's output, not this operation's.
      if (ts.isFunctionLike(child)) {
        ts.forEachChild(child, (c) => visit(c, false));
        return;
      }
      visit(child, childInReturn);
    });
  };

  // A function body itself or a concise arrow body expression.
  visit(body, !ts.isBlock(body));
  return out.sort((a, b) => a.line - b.line);
}

/** Body of a non-exported function declared in `sf` (declaration or `const f = () => …`). */
function localFunctionBody(decl: ts.Declaration, sf: ts.SourceFile): ts.Node | undefined {
  if (decl.getSourceFile() !== sf) return undefined;
  if (ts.isFunctionDeclaration(decl) && decl.body && !isExported(decl)) return decl.body;
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
  ) {
    const statement = decl.parent.parent;
    if (ts.isVariableStatement(statement) && !isExported(statement)) return decl.initializer.body;
  }
  return undefined;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isConciseArrowBody(node: ts.Node): boolean {
  return ts.isArrowFunction(node.parent) && node.parent.body === node && !ts.isBlock(node);
}

function isDeclarationName(node: ts.Identifier): boolean {
  const p = node.parent;
  return (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)) && p.name === node;
}

/** `"object"` in `typeof x === "object"` or `"code" in x` is a test, not something returned. */
function isOperandOfTest(node: ts.Node): boolean {
  const p = node.parent;
  if (!ts.isBinaryExpression(p)) return false;
  const op = p.operatorToken.kind;
  return (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.InKeyword ||
    op === ts.SyntaxKind.InstanceOfKeyword ||
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken
  );
}

/** A message passed to `new SomethingError(...)`, returned or thrown: wording, not a decision. */
function isErrorMessage(node: ts.Node): boolean {
  const p = node.parent;
  return (
    ts.isNewExpression(p) &&
    /(?:Error|Exception)$/.test(p.expression.getText()) &&
    (p.arguments ?? []).some((a) => a === node)
  );
}

function isPropertyKey(node: ts.Node): boolean {
  return ts.isPropertyAssignment(node.parent) && node.parent.name === node;
}

function isStringLike(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function hasWordCharacter(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function isTrivialNumber(value: number): boolean {
  return value === 0 || value === 1 || value === -1 || Number.isNaN(value);
}

function numberText(value: number): string {
  return String(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/**
 * Whether the contract text names a decision: one of its values (numbers compared by value,
 * so `86_400_000`, `86,400,000` and `8.64e7` all count; a string where no letter directly
 * precedes or follows it, so `"1d"` names `d` but `"day"` does not; a plural `s` may follow) or one of its constant names written
 * in a code span (names shorter than three characters, such as `d` or `mo`, are ignored: they
 * collide with ordinary words and unit names).
 */
export function decisionMentioned(decision: Decision, corpus: string, ignore: ReadonlySet<string>): boolean {
  if (decision.values.some((v) => ignore.has(v)) || decision.names.some((n) => ignore.has(n))) return true;
  const numbers = numbersIn(corpus);
  for (const value of decision.values) {
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n) && /^-?[\d.e+]+$/i.test(value)) {
      if (numbers.some((m) => Math.abs(m - n) <= Math.abs(n) * 1e-9)) return true;
      continue;
    }
    // A digit may touch the value ("1d", "2.5hrs"); a letter may not ("d" is not named by "day").
    // ...and a letter may not follow, except a plural "s" ("years" names "year").
    const left = /^[\p{L}\p{N}_]/u.test(value) ? "(?<![\\p{L}_])" : "";
    const right = /[\p{L}]$/u.test(value) ? "(?:(?![\\p{L}])|(?=s(?![\\p{L}])))" : "";
    if (new RegExp(`${left}${escapeRegExp(value)}${right}`, "u").test(corpus)) return true;
  }
  const code = codeSpansIn(corpus);
  for (const name of decision.names) {
    if (name.length < 3) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(name)}(?![\\p{L}\\p{N}_$])`, "u");
    if (code.some((c) => re.test(c))) return true;
  }
  return false;
}

/** Contents of inline code spans; a constant's name counts only there, never as a plain word. */
function codeSpansIn(text: string): string[] {
  return [...text.matchAll(/`+([^`]+)`+/g)].map((m) => m[1] ?? "");
}

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d[\d_,]*(?:\.\d+)?(?:e[+-]?\d+)?/gi)) {
    const n = Number(m[0].replace(/[_,]/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
