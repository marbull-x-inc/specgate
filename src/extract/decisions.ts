import ts from "typescript";
import type { Decision, DecisionKind, MemberProbe } from "../ir/schema.ts";
import { relativeTo } from "../util/paths.ts";
import { lineOf, type ProgramHost } from "./program.ts";

/** A collection whose elements were cut at `decisions.collectionLimit`. */
export interface TruncatedCollection {
  name: string;
  file: string;
  /** Literal elements the collection holds */
  size: number;
}

export interface DecisionOptions {
  /** Repository root; `member` decisions record their collection's module relative to it. */
  root: string;
  /** Most `member` decisions per collection (`decisions.collectionLimit`). */
  collectionLimit: number;
  /** Called once per collection cut at the limit. */
  onTruncated?: (collection: TruncatedCollection) => void;
  /** Called with each helper or same-module function body the walk follows (`Unit.helperRanges`). */
  onFollow?: (body: ts.Node) => void;
  /** Called with each module-level `const` (not a function) the walk reads (`Unit.constantRanges`). */
  onConstant?: (declaration: ts.VariableDeclaration) => void;
}

/** A literal element of a collection constant, with the constant it is written in. */
interface CollectionElement {
  value: string;
  name: string;
  file: string;
  /** Lines of the constant's declaration */
  line: number;
  endLine: number;
}

const DEFAULT_OPTIONS: DecisionOptions = { root: ".", collectionLimit: 500 };

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
 * Membership in a module-level collection is a decision per element (`member`): removing
 * `"/delete-user"` from a deny list changes behaviour as much as changing a boundary does. The
 * collection is a `const` array, `Set`, `Map` (keys) or, for `in` / `Object.hasOwn`, object
 * literal; spreads of other such constants are followed, and each element is attributed to the
 * constant it is written in. Recognised probes: `includes` / `indexOf` / `lastIndexOf` / `has`,
 * `v in X`, `Object.hasOwn(X, v)`, and `some` / `find` / `findIndex` / `findLast` /
 * `findLastIndex` whose callback compares the element with `===`, `startsWith`, `endsWith` or
 * `includes`.
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
  options: DecisionOptions = DEFAULT_OPTIONS,
): Decision[] {
  const out: Decision[] = [];
  const memberCounts = new Map<string, number>();
  const truncated = new Set<string>();
  const seen = new Set<string>();
  const visitedBodies = new Set<ts.Node>();
  const recordedConstants = new Set<ts.Node>();
  /** Constants some boundary compares with a `.length` / `.size` */
  const lengthNames = new Set<string>();

  const add = (kind: DecisionKind, node: ts.Node, values: string[], names: string[], readKey?: string): void => {
    if (values.length === 0) return;
    const key = `${kind}|${values.join("|")}|${names.join("|")}|${readKey ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind,
      expression: oneLine(node.getText(sf)),
      line: lineOf(sf, node.getStart(sf)),
      values,
      names,
      ...(readKey !== undefined ? { key: readKey } : {}),
    });
  };

  /** A string literal, or a `const` initialised with one (any module). */
  const stringValue = (node: ts.Expression): string | undefined => {
    const e = unwrapExpression(node);
    if (isStringLike(e)) return e.text;
    const decl = constDeclarationOf(e);
    if (!decl?.initializer) return undefined;
    const init = unwrapExpression(decl.initializer);
    return isStringLike(init) ? init.text : undefined;
  };

  /** The constant key a value is read with: `params.get(K)`, `obj[K]`, `obj.K`. */
  const readKeyOf = (side: ts.Expression): string | undefined => {
    const e = unwrapExpression(side);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "get") {
      const arg = e.arguments[0];
      return e.arguments.length === 1 && arg ? stringValue(arg) : undefined;
    }
    if (ts.isElementAccessExpression(e)) return stringValue(e.argumentExpression);
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return undefined;
  };

  /**
   * A string configuring a library call: a property value of an object literal passed straight to
   * a function declared only outside the project (`z.toJSONSchema(S, { io: "input" })`). It is
   * not observable output of the unit.
   */
  const isLibraryOption = (node: ts.Node): boolean => {
    const prop = node.parent;
    if (!ts.isPropertyAssignment(prop) || prop.initializer !== node) return false;
    let obj: ts.Node = prop.parent;
    while (
      ts.isParenthesizedExpression(obj.parent) ||
      ts.isAsExpression(obj.parent) ||
      ts.isSatisfiesExpression(obj.parent)
    )
      obj = obj.parent;
    const call = obj.parent;
    if (!ts.isObjectLiteralExpression(prop.parent) || !ts.isCallExpression(call)) return false;
    if (!call.arguments.some((a) => a === obj)) return false;
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    const decls = host.declarationsOf(callee);
    return decls.length > 0 && decls.every((d) => isOutsideProject(d.getSourceFile().fileName));
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

  /** A module-level `const` declaration (any module) that `node` names. */
  const moduleConstOf = (node: ts.Expression): ts.VariableDeclaration | undefined => {
    const decl = constDeclarationOf(node);
    if (!decl || !ts.isIdentifier(decl.name)) return undefined;
    const statement = decl.parent.parent;
    return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent) ? decl : undefined;
  };

  /**
   * The literal elements of a collection constant, each with the constant it is written in.
   * `keys` selects object-literal keys (for `in` / `Object.hasOwn`) over array-like elements.
   */
  const collectionElements = (node: ts.Expression, keys: boolean, depth = 0): CollectionElement[] | undefined => {
    if (depth > 5) return undefined;
    // An array literal probed in place: `["self", "src"].includes(item)` (#69).
    const literal = unwrapExpression(node);
    if (depth === 0 && !keys && ts.isArrayLiteralExpression(literal)) {
      const line = lineOf(sf, literal.getStart(sf));
      const where = {
        name: `inline list at line ${line}`,
        file: relativeTo(options.root, sf.fileName),
        line,
        endLine: lineOf(sf, literal.getEnd()),
      };
      return literal.elements.flatMap((el) => {
        const value = literalText(unwrapExpression(el));
        return value === undefined ? [] : [{ value, ...where }];
      });
    }
    const decl = moduleConstOf(node);
    if (!decl?.initializer || !ts.isIdentifier(decl.name)) return undefined;
    const declSf = decl.getSourceFile();
    const statement = decl.parent.parent;
    const where = {
      name: decl.name.text,
      file: relativeTo(options.root, declSf.fileName),
      line: lineOf(declSf, statement.getStart(declSf)),
      endLine: lineOf(declSf, statement.getEnd()),
    };
    let init = unwrapExpression(decl.initializer);
    const out: CollectionElement[] = [];
    if (keys) {
      if (!ts.isObjectLiteralExpression(init)) return undefined;
      for (const p of init.properties) {
        if (ts.isSpreadAssignment(p)) out.push(...(collectionElements(p.expression, true, depth + 1) ?? []));
        else if (p.name) {
          const key = propertyKeyText(p.name);
          if (key !== undefined) out.push({ value: key, ...where });
        }
      }
      return out;
    }
    let isMap = false;
    if (
      ts.isNewExpression(init) &&
      ts.isIdentifier(init.expression) &&
      (init.expression.text === "Set" || init.expression.text === "Map")
    ) {
      isMap = init.expression.text === "Map";
      const arg = init.arguments?.[0];
      if (!arg) return out;
      const inner = unwrapExpression(arg);
      if (ts.isIdentifier(inner)) return collectionElements(inner, false, depth + 1);
      init = inner;
    }
    if (!ts.isArrayLiteralExpression(init)) return undefined;
    for (const raw of init.elements) {
      if (ts.isSpreadElement(raw)) {
        out.push(...(collectionElements(raw.expression, false, depth + 1) ?? []));
        continue;
      }
      let el = unwrapExpression(raw);
      if (isMap) {
        if (!ts.isArrayLiteralExpression(el) || !el.elements[0]) continue;
        el = unwrapExpression(el.elements[0]);
      }
      const value = literalText(el);
      if (value !== undefined) out.push({ value, ...where });
    }
    return out;
  };

  /**
   * The key a collection is read with, when the operation passes the collection to a call together
   * with a string literal: `useQueryEnum("view", VIEWS, "list")`, `parseEnum(params, "view", VIEWS)`.
   * The first string literal argument is the key. Only the operation's own body is searched.
   */
  let collectionKeys: Map<ts.VariableDeclaration, string> | undefined;
  const collectionKeyOf = (receiver: ts.Expression): string | undefined => {
    const decl = moduleConstOf(receiver);
    if (!decl) return undefined;
    if (!collectionKeys) {
      const found = new Map<ts.VariableDeclaration, string>();
      const scan = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const literal = n.arguments.map(unwrapExpression).find(isStringLike);
          if (literal && literal.text.length > 0)
            for (const arg of n.arguments) {
              const d = moduleConstOf(unwrapExpression(arg));
              if (d && !found.has(d)) found.set(d, literal.text);
            }
        }
        ts.forEachChild(n, scan);
      };
      scan(body);
      collectionKeys = found;
    }
    return collectionKeys.get(decl);
  };

  /** Records one `member` decision per element of the collection `receiver`, up to the limit. */
  const addMembers = (usage: ts.Node, receiver: ts.Expression, probe: MemberProbe, keys: boolean): void => {
    const elements = collectionElements(receiver, keys);
    if (!elements) return;
    const receiverName = ts.isIdentifier(receiver) ? receiver.text : undefined;
    const readKey = keys ? undefined : collectionKeyOf(receiver);
    const sizes = new Map<string, number>();
    for (const e of elements) sizes.set(`${e.file}#${e.name}`, (sizes.get(`${e.file}#${e.name}`) ?? 0) + 1);
    for (const e of elements) {
      const collectionKey = `${e.file}#${e.name}`;
      const key = `member|${e.value}|${collectionKey}|${probe}`;
      if (seen.has(key)) continue;
      const count = memberCounts.get(collectionKey) ?? 0;
      if (count >= options.collectionLimit) {
        if (!truncated.has(collectionKey)) {
          truncated.add(collectionKey);
          options.onTruncated?.({ name: e.name, file: e.file, size: sizes.get(collectionKey) ?? count });
        }
        continue;
      }
      seen.add(key);
      memberCounts.set(collectionKey, count + 1);
      out.push({
        kind: "member",
        expression: oneLine(usage.getText(sf)),
        line: lineOf(sf, usage.getStart(sf)),
        values: [e.value],
        names: unique([...(receiverName ? [receiverName] : []), e.name]),
        collection: { name: e.name, file: e.file, line: e.line, endLine: e.endLine },
        probe,
        ...(readKey !== undefined ? { key: readKey } : {}),
      });
    }
  };

  /** Membership tests: `X.includes(v)`, `X.has(v)`, `v in X`, `X.some((p) => v.startsWith(p))` … */
  const visitMembership = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      addMembers(node, unwrapExpression(node.right), "exact", true);
      return;
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    const receiver = unwrapExpression(node.expression.expression);
    if (method === "hasOwn" && ts.isIdentifier(receiver) && receiver.text === "Object" && node.arguments[0]) {
      addMembers(node, unwrapExpression(node.arguments[0]), "exact", true);
      return;
    }
    if (method === "hasOwnProperty") {
      addMembers(node, receiver, "exact", true);
      return;
    }
    if (EXACT_MEMBER_METHODS.has(method)) {
      addMembers(node, receiver, "exact", false);
      return;
    }
    if (CALLBACK_MEMBER_METHODS.has(method)) {
      const probe = callbackProbe(node.arguments[0]);
      if (probe) addMembers(node, receiver, probe, false);
    }
  };

  const visit = (node: ts.Node, inReturn: boolean): void => {
    visitMembership(node);

    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const decl = constDeclarationOf(node);
      if (decl) recordConstant(decl);
      const moduleConst = moduleConstOf(node);
      if (
        moduleConst?.initializer &&
        !ts.isArrowFunction(moduleConst.initializer) &&
        !ts.isFunctionExpression(moduleConst.initializer)
      )
        options.onConstant?.(moduleConst);
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
        if (constant && !isTrivialNumber(constant.value)) {
          add("boundary", node, [numberText(constant.value)], constant.names);
          // `items.length > MAX_ITEMS`: a test pins it with arrays of that size (#56).
          const other = constant === l ? node.right : node.left;
          if (isLengthRead(other)) {
            const last = out[out.length - 1];
            if (last?.kind === "boundary" && last.line === lineOf(sf, node.getStart(sf))) last.length = true;
            for (const n of constant.names) lengthNames.add(n);
          }
        }
      } else if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        if (!isTypeofSide(node.left) && !isTypeofSide(node.right)) {
          for (const side of [node.left, node.right]) {
            const other = side === node.left ? node.right : node.left;
            const readKey = readKeyOf(other);
            if (isStringLike(side) && side.text.length > 0) add("match", node, [side.text], [], readKey);
            else {
              const v = sideValue(side);
              if (v && !isTrivialNumber(v.value)) add("match", node, [numberText(v.value)], v.names, readKey);
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
        if (!isIndexArithmetic(node, host))
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

    if (
      inReturn &&
      !isPropertyKey(node) &&
      !isOperandOfTest(node) &&
      !isErrorMessage(node) &&
      !isLibraryOption(node) &&
      !isInTypePosition(node) &&
      !isReplacementPattern(node) &&
      !isInlineCollectionElement(node)
    ) {
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
          options.onFollow?.(helperBody);
          visit(helperBody, false);
        }
      } else if (ts.isIdentifier(callee)) {
        for (const decl of host.declarationsOf(callee)) {
          const local = localFunctionBody(decl, sf);
          if (local && !visitedBodies.has(local)) {
            visitedBodies.add(local);
            options.onFollow?.(local);
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
  for (const d of out) if (d.kind === "constant" && d.names.some((n) => lengthNames.has(n))) d.length = true;
  return out.sort((a, b) => a.line - b.line);
}

/** Body of a non-exported function declared in `sf` (declaration or `const f = () => …`). */
const EXACT_MEMBER_METHODS = new Set(["includes", "indexOf", "lastIndexOf", "has"]);
const CALLBACK_MEMBER_METHODS = new Set(["some", "find", "findIndex", "findLast", "findLastIndex"]);

/**
 * How a `some` / `find` callback compares its parameter with the input:
 * `(p) => v === p` (exact), `v.startsWith(p)` (prefix), `v.endsWith(p)` (suffix),
 * `v.includes(p)` (contains). Anything else is not a membership test.
 */
function callbackProbe(arg: ts.Expression | undefined): MemberProbe | undefined {
  if (!arg || !(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return undefined;
  const param = arg.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return undefined;
  const isParam = (e: ts.Expression): boolean => {
    const u = unwrapExpression(e);
    return ts.isIdentifier(u) && u.text === param.text;
  };
  let found: MemberProbe | undefined;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.arguments[0] &&
      isParam(n.arguments[0])
    ) {
      const m = n.expression.name.text;
      if (m === "startsWith") found = "prefix";
      else if (m === "endsWith") found = "suffix";
      else if (m === "includes") found = "contains";
    }
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      (isParam(n.left) || isParam(n.right))
    )
      found = "exact";
    if (!found) ts.forEachChild(n, walk);
  };
  walk(arg.body);
  return found;
}

/** Strips `(…)`, `… as T`, `… satisfies T`, `<T>…` and `…!` around an expression. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  )
    cur = cur.expression;
  return cur;
}

/** A string or non-trivial number literal as decision text. */
function literalText(node: ts.Expression): string | undefined {
  if (isStringLike(node)) return node.text.length > 0 ? node.text : undefined;
  if (ts.isNumericLiteral(node)) return isTrivialNumber(Number(node.text)) ? undefined : numberText(Number(node.text));
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    const v = -Number(node.operand.text);
    return isTrivialNumber(v) ? undefined : numberText(v);
  }
  return undefined;
}

function propertyKeyText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return numberText(Number(name.text));
  return undefined;
}

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

/** `x.length` or `x.size`. */
function isLengthRead(node: ts.Expression): boolean {
  const e = unwrapExpression(node);
  return ts.isPropertyAccessExpression(e) && (e.name.text === "length" || e.name.text === "size");
}

/** A declaration file or an installed package: code the project does not own. */
function isOutsideProject(fileName: string): boolean {
  return fileName.endsWith(".d.ts") || /[\\/]node_modules[\\/]/.test(fileName);
}

function isPropertyKey(node: ts.Node): boolean {
  return ts.isPropertyAssignment(node.parent) && node.parent.name === node;
}

/** Inside a type (`as Cased<T, O["normalize"]>`): erased at run time, never a decision (#65). */
function isInTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

/** The replacement argument of `s.replace(re, "$1-$2")` / `replaceAll`: a pattern, not output (#68). */
function isReplacementPattern(node: ts.Node): boolean {
  const call = node.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[1] === node &&
    ts.isPropertyAccessExpression(call.expression) &&
    (call.expression.name.text === "replace" || call.expression.name.text === "replaceAll")
  );
}

/** An element of an array literal probed in place (`["self", "src"].includes(x)`): a member (#69). */
function isInlineCollectionElement(node: ts.Node): boolean {
  let list: ts.Node = node.parent;
  if (!ts.isArrayLiteralExpression(list)) return false;
  while (ts.isParenthesizedExpression(list.parent) || ts.isAsExpression(list.parent)) list = list.parent;
  const access = list.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== list) return false;
  const method = access.name.text;
  return (
    ts.isCallExpression(access.parent) && (EXACT_MEMBER_METHODS.has(method) || CALLBACK_MEMBER_METHODS.has(method))
  );
}

/**
 * Arithmetic that only computes an array index: `out[i * 2 + 2]`, or a variable holding it that
 * is read only as an index (`const index = i * 2 + 2; values[index] = …`). The numbers lay out
 * an internal array; a caller does not observe them (#68).
 */
function isIndexArithmetic(node: ts.BinaryExpression, host: ProgramHost): boolean {
  let top: ts.Node = node;
  while (ts.isBinaryExpression(top.parent) || ts.isParenthesizedExpression(top.parent)) top = top.parent;
  const parent = top.parent;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === top) return true;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== top || !ts.isIdentifier(parent.name)) return false;
  const name = parent.name;
  let scope: ts.Node = parent;
  while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let reads = 0;
  let indexReads = 0;
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n !== name && n.text === name.text && host.declarationsOf(n).includes(parent)) {
      reads++;
      if (ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n) indexReads++;
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  return reads > 0 && reads === indexReads;
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
