import ts from "typescript";
import type { Config } from "../config/schema.ts";
import type { Entity, Guarantee, PortDecl, Unit } from "../ir/schema.ts";
import { textHash } from "../util/hash.ts";
import { relativeTo } from "../util/paths.ts";
import { docCommentOf, lineOf, type ProgramHost } from "./program.ts";
import { type ParsedDoc, parseDocComment, type TSDocParser } from "./tsdoc-parser.ts";

/**
 * A specification unit together with the syntax it was extracted from.
 *
 * @remarks
 * `unit` is the language-neutral IR; the extra fields exist for later passes (test linking,
 * identifier resolution, scaffold, provenance) that need positions and declarations. They are
 * never serialised.
 */
export interface ExtractedUnit {
  unit: Unit;
  doc: ParsedDoc | undefined;
  docComment: { pos: number; end: number; text: string } | undefined;
  declaration: ts.Node;
  nameNode: ts.Node;
  sourceFile: ts.SourceFile;
  /** Declarations of callees in the body; resolved to surface units in a second pass. */
  calleeDeclarations: ts.Declaration[];
  /** Local names of error classes thrown in the body (for scaffold). */
  thrownErrorTypes: string[];
  /** Where each named import in the file comes from, so generators can re-import error types. */
  importSources: Map<string, string>;
}

export interface SurfaceExtraction {
  units: ExtractedUnit[];
  entities: Entity[];
  ports: PortDecl[];
  docMessages: Array<{ file: string; line: number; text: string }>;
}

interface Context {
  host: ProgramHost;
  config: Config;
  parser: TSDocParser;
  testFiles: ReadonlySet<string>;
  referenceIndex: Map<string, Set<string>>;
}

const PRIVATE_FLAGS = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;

function hasPrivateName(node: ts.ClassElement): boolean {
  return node.name !== undefined && ts.isPrivateIdentifier(node.name);
}

function isNonPublic(member: ts.ClassElement): boolean {
  return hasPrivateName(member) || (ts.getCombinedModifierFlags(member) & PRIVATE_FLAGS) !== 0;
}

function isPublicMethod(member: ts.ClassElement): member is ts.MethodDeclaration {
  if (!ts.isMethodDeclaration(member)) return false;
  if (hasPrivateName(member)) return false;
  return (ts.getCombinedModifierFlags(member) & PRIVATE_FLAGS) === 0;
}

function referenceKey(file: string, name: string): string {
  return `${file}::${name}`;
}

/**
 * Indexes which files import which exported declaration, following import aliases.
 * Test files never count as referrers: a unit used only by its own tests is not part of a
 * module's public surface.
 */
function buildReferenceIndex(host: ProgramHost, testFiles: ReadonlySet<string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (decl: ts.Declaration, fromFile: string): void => {
    const declFile = decl.getSourceFile().fileName;
    if (declFile === fromFile) return;
    const name = ts.getNameOfDeclaration(decl)?.getText();
    if (!name) return;
    const key = referenceKey(declFile, name);
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(fromFile);
  };
  for (const sf of host.files) {
    if (testFiles.has(sf.fileName)) continue;
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const spec of bindings.elements)
            for (const decl of host.declarationsOf(spec.name)) add(decl, sf.fileName);
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          const moduleSymbolDecls = host.declarationsOf(statement.moduleSpecifier);
          const target = moduleSymbolDecls[0];
          if (target && ts.isSourceFile(target)) {
            for (const decls of host.exportsOf(target).values()) for (const decl of decls) add(decl, sf.fileName);
          }
        }
        if (statement.importClause.name)
          for (const decl of host.declarationsOf(statement.importClause.name)) add(decl, sf.fileName);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const spec of statement.exportClause.elements)
          for (const decl of host.declarationsOf(spec.name)) add(decl, sf.fileName);
      }
    }
  }
  return index;
}

function collectEnvInputs(
  body: ts.Node,
  sf: ts.SourceFile,
  forbid: readonly string[],
): Array<{ expression: string; line: number }> {
  const out: Array<{ expression: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    let candidate: string | undefined;
    if (ts.isPropertyAccessExpression(node)) candidate = node.getText(sf);
    else if (ts.isNewExpression(node)) candidate = `new ${node.expression.getText(sf)}`;
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) candidate = node.expression.text;
    if (candidate !== undefined) {
      const hit = forbid.find((f) => candidate === f || candidate.startsWith(`${f}.`) || candidate.startsWith(`${f}(`));
      if (hit) {
        out.push({ expression: candidate, line: lineOf(sf, node.getStart(sf)) });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

interface BodyScan {
  portCalls: Map<string, Map<string, number>>;
  calleeDeclarations: ts.Declaration[];
  thrownErrorTypes: string[];
}

/**
 * Walks a body and, for class methods, the private helpers it calls on `this` (transitively,
 * cycle-safe). Private helpers are part of the operation, not units of their own, so the ports
 * they touch and the errors they throw belong to the public operation that reaches them.
 */
function scanBody(
  body: ts.Node,
  host: ProgramHost,
  portMembers: ReadonlySet<string>,
  portParams: ReadonlySet<string>,
  helpers: ReadonlyMap<string, ts.Node> = new Map(),
): BodyScan {
  const portCalls = new Map<string, Map<string, number>>();
  const calleeDeclarations: ts.Declaration[] = [];
  const thrown = new Set<string>();
  const visitedHelpers = new Set<string>();
  const recordCall = (port: string, member: string): void => {
    let members = portCalls.get(port);
    if (!members) {
      members = new Map();
      portCalls.set(port, members);
    }
    members.set(member, (members.get(member) ?? 0) + 1);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const receiver = callee.expression;
        if (
          ts.isPropertyAccessExpression(receiver) &&
          receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
          portMembers.has(receiver.name.text)
        ) {
          recordCall(receiver.name.text, callee.name.text);
        } else if (receiver.kind === ts.SyntaxKind.ThisKeyword && helpers.has(callee.name.text)) {
          const helperName = callee.name.text;
          if (!visitedHelpers.has(helperName)) {
            visitedHelpers.add(helperName);
            const helperBody = helpers.get(helperName);
            if (helperBody) visit(helperBody);
          }
        } else if (ts.isIdentifier(receiver) && portParams.has(receiver.text)) {
          recordCall(receiver.text, callee.name.text);
        } else {
          calleeDeclarations.push(...host.declarationsOf(callee.name));
        }
      } else if (ts.isIdentifier(callee)) {
        calleeDeclarations.push(...host.declarationsOf(callee));
      }
    }
    if (
      ts.isThrowStatement(node) &&
      ts.isNewExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      thrown.add(node.expression.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { portCalls, calleeDeclarations, thrownErrorTypes: [...thrown] };
}

function importSourcesOf(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause)
      continue;
    const source = statement.moduleSpecifier.text;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) map.set(spec.name.text, source);
    if (statement.importClause.name) map.set(statement.importClause.name.text, source);
  }
  return map;
}

function guaranteeKind(id: string): string {
  const first = id.split(".")[0] ?? id;
  return ["ok", "err", "atomic", "frame", "idempotent"].includes(first) ? first : "other";
}

function buildGuarantees(unitId: string, doc: ParsedDoc, docStartLine: number): Guarantee[] {
  const out: Guarantee[] = [];
  const push = (
    idToken: string | undefined,
    text: string,
    source: Guarantee["source"],
    lineOffset: number,
    throwsType?: string,
  ): void => {
    // An invalid or missing id is still recorded (as the raw token) so rules can point at it.
    const id = idToken ?? "";
    out.push({
      id,
      key: `${unitId}.${id}`,
      kind: guaranteeKind(id),
      source,
      text,
      textHash: textHash(`${throwsType ?? ""}|${text}`),
      ...(throwsType ? { throws: throwsType } : {}),
      line: docStartLine + lineOffset,
      references: [],
      tests: [],
    });
  };
  for (const g of doc.guarantees) push(g.idToken, g.text, "guarantee", g.lineOffset);
  for (const t of doc.throws) push(t.idToken, t.text, "throws", t.lineOffset, t.errorType);
  return out;
}

function paramsOf(host: ProgramHost, fn: ts.SignatureDeclaration, doc: ParsedDoc | undefined): Unit["params"] {
  return fn.parameters
    .filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"))
    .map((p) => {
      const name = p.name.getText();
      const documented = doc?.params.get(name);
      return {
        name,
        type: host.typeNodeToString(p.type, p),
        optional: p.questionToken !== undefined || p.initializer !== undefined,
        ...(documented !== undefined ? { doc: documented } : {}),
      };
    });
}

function returnsOf(host: ProgramHost, fn: ts.SignatureDeclaration): string {
  if (fn.type) return fn.type.getText();
  const signature = host.checker.getSignatureFromDeclaration(fn);
  if (!signature) return "unknown";
  return host.checker.typeToString(signature.getReturnType(), fn, ts.TypeFormatFlags.NoTruncation);
}

function zodPropertyNames(initializer: ts.Expression, sf: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "object"
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) if (prop.name) names.push(prop.name.getText(sf));
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  return names;
}

function memberNames(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeLiteralNode,
  sf: ts.SourceFile,
): string[] {
  const names: string[] = [];
  for (const member of node.members) {
    if ("name" in member && member.name && !ts.isPrivateIdentifier(member.name)) {
      if (ts.isClassElement(member) && (ts.getCombinedModifierFlags(member) & PRIVATE_FLAGS) !== 0) continue;
      names.push(member.name.getText(sf));
    }
  }
  return names;
}

function describeExtraction(
  ctx: Context,
  sf: ts.SourceFile,
  node: ts.Node,
): { doc: ParsedDoc | undefined; comment: ReturnType<typeof docCommentOf>; docLine: number } {
  const comment = docCommentOf(sf, node);
  if (!comment) return { doc: undefined, comment: undefined, docLine: 0 };
  const doc = parseDocComment(ctx.parser, comment.text);
  const docLine = lineOf(sf, comment.pos);
  return { doc, comment, docLine };
}

/**
 * Extracts specification units, entities and ports from the surface files.
 *
 * @remarks
 * A unit is an operation that another module can call: an exported function, a public method
 * of an exported class, or an interface marked `@port`. With `surface.mode = "referenced"` the
 * declaring export must also be imported by at least one non-test module; an export nobody
 * uses has no consumers to promise anything to and is left out. Internal helpers, private
 * methods and unexported functions never become units, which keeps how an operation is split
 * internally outside the specification.
 */
export function extractSurface(
  host: ProgramHost,
  config: Config,
  parser: TSDocParser,
  surfaceFiles: readonly string[],
  testFiles: readonly string[],
): SurfaceExtraction {
  const testSet = new Set(testFiles);
  const ctx: Context = { host, config, parser, testFiles: testSet, referenceIndex: buildReferenceIndex(host, testSet) };
  const units: ExtractedUnit[] = [];
  const entities: Entity[] = [];
  const ports: PortDecl[] = [];
  const docMessages: SurfaceExtraction["docMessages"] = [];
  const classPattern = config.surface.classPattern ? new RegExp(config.surface.classPattern) : undefined;

  for (const fileName of surfaceFiles) {
    const sf = host.program.getSourceFile(fileName);
    if (!sf) continue;
    const relFile = relativeTo(config.root, sf.fileName);
    const exported = host.exportsOf(sf);
    const importSources = importSourcesOf(sf);

    const referencedBy = (name: string): string[] => {
      const set = ctx.referenceIndex.get(referenceKey(sf.fileName, name));
      return set ? [...set].map((f) => relativeTo(config.root, f)).sort() : [];
    };
    const inSurface = (name: string): boolean => {
      if (!exported.has(name)) return false;
      return config.surface.mode === "exported" || referencedBy(name).length > 0;
    };
    const recordDocMessages = (doc: ParsedDoc | undefined, docLine: number): void => {
      if (!doc) return;
      for (const m of doc.messages) docMessages.push({ file: relFile, line: docLine + m.lineOffset, text: m.text });
    };

    const addFunctionUnit = (
      name: string,
      fn: ts.SignatureDeclaration,
      docNode: ts.Node,
      nameNode: ts.Node,
      referencers: string[],
      target?: string,
    ): void => {
      const { doc, comment, docLine } = describeExtraction(ctx, sf, docNode);
      recordDocMessages(doc, docLine);
      const unitId = target ? `${target}#${name}` : name;
      const body: ts.Node | undefined = "body" in fn && fn.body ? fn.body : undefined;
      const portParams = new Set(fn.parameters.map((p) => p.name.getText()));
      const scan = body
        ? scanBody(body, host, new Set(), portParams)
        : { portCalls: new Map<string, Map<string, number>>(), calleeDeclarations: [], thrownErrorTypes: [] };
      const unit: Unit = {
        id: unitId,
        kind: target ? "method" : "function",
        ...(target ? { target } : {}),
        operation: name,
        file: relFile,
        line: lineOf(sf, fn.getStart(sf)),
        endLine: lineOf(sf, fn.getEnd()),
        referencedBy: referencers,
        summary: doc?.summary ?? "",
        ...(doc?.remarks ? { remarks: doc.remarks } : {}),
        params: paramsOf(host, fn, doc),
        returns: returnsOf(host, fn),
        uses: doc?.uses ?? [],
        modifies: doc?.modifies ?? [],
        injectedPorts: [],
        portCalls: [...scan.portCalls].flatMap(([port, members]) =>
          [...members].map(([member, count]) => ({ port, member, count })),
        ),
        operationCalls: [],
        envInputs: body ? collectEnvInputs(body, sf, config.envInputs.forbid) : [],
        implHash: textHash(body ? body.getText(sf) : ""),
        guarantees: doc ? buildGuarantees(unitId, doc, docLine) : [],
        examples: (doc?.examples ?? []).map((e) => ({
          expression: e.expression,
          expected: e.expected,
          line: docLine + e.lineOffset,
        })),
        ...(doc?.supersedes ? { supersedes: doc.supersedes } : {}),
        hasDoc: doc !== undefined,
      };
      units.push({
        unit,
        doc,
        docComment: comment,
        declaration: fn,
        nameNode,
        sourceFile: sf,
        calleeDeclarations: scan.calleeDeclarations,
        thrownErrorTypes: scan.thrownErrorTypes,
        importSources,
      });
    };

    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const name = statement.name.text;
        if (inSurface(name)) addFunctionUnit(name, statement, statement, statement.name, referencedBy(name));
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const name = decl.name.text;
          const init = decl.initializer;
          const { doc, docLine } = describeExtraction(ctx, sf, statement);
          if (doc?.isEntity && exported.has(name)) {
            recordDocMessages(doc, docLine);
            entities.push({
              name,
              file: relFile,
              line: lineOf(sf, decl.getStart(sf)),
              properties: zodPropertyNames(init, sf),
              invariants: doc.invariants.map((i) => ({ text: i.text, textHash: textHash(i.text) })),
              description: doc.summary,
            });
            continue;
          }
          if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && inSurface(name)) {
            addFunctionUnit(name, init, statement, decl.name, referencedBy(name));
          }
        }
        continue;
      }
      if (ts.isClassDeclaration(statement) && statement.name) {
        const className = statement.name.text;
        if (!exported.has(className)) continue;
        const { doc: classDoc, docLine: classDocLine } = describeExtraction(ctx, sf, statement);
        recordDocMessages(classDoc, classDocLine);
        if (classDoc?.isEntity) {
          entities.push({
            name: className,
            file: relFile,
            line: lineOf(sf, statement.getStart(sf)),
            properties: memberNames(statement, sf),
            invariants: classDoc.invariants.map((i) => ({ text: i.text, textHash: textHash(i.text) })),
            description: classDoc.summary,
          });
          continue;
        }
        if (classPattern && !classPattern.test(className)) continue;
        if (!inSurface(className)) continue;
        const referencers = referencedBy(className);
        const injected: Unit["injectedPorts"] = [];
        const ctor = statement.members.find(ts.isConstructorDeclaration);
        if (ctor) {
          for (const p of ctor.parameters) {
            const flags = ts.getCombinedModifierFlags(p);
            if ((flags & ts.ModifierFlags.ParameterPropertyModifier) !== 0 && ts.isIdentifier(p.name)) {
              injected.push({
                member: p.name.text,
                type: host.typeNodeToString(p.type, p),
                members: host.membersOf(p.type ?? p),
              });
            }
          }
        }
        for (const member of statement.members) {
          if (
            ts.isPropertyDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.type &&
            (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) === 0
          ) {
            injected.push({
              member: member.name.text,
              type: member.type.getText(sf),
              members: host.membersOf(member.type),
            });
          }
        }
        const portMembers = new Set(injected.map((i) => i.member));
        // Non-public methods (and arrow-function properties) reachable through `this.x()`.
        const helpers = new Map<string, ts.Node>();
        for (const member of statement.members) {
          if (ts.isMethodDeclaration(member) && isNonPublic(member) && member.body && member.name) {
            helpers.set(member.name.getText(sf), member.body);
          } else if (
            ts.isPropertyDeclaration(member) &&
            member.name &&
            member.initializer &&
            (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
          ) {
            helpers.set(member.name.getText(sf), member.initializer.body);
          }
        }
        for (const member of statement.members) {
          if (!isPublicMethod(member) || !member.name) continue;
          const methodName = member.name.getText(sf);
          const { doc, comment, docLine } = describeExtraction(ctx, sf, member);
          recordDocMessages(doc, docLine);
          const unitId = `${className}#${methodName}`;
          const scan = member.body
            ? scanBody(member.body, host, portMembers, new Set(), helpers)
            : { portCalls: new Map<string, Map<string, number>>(), calleeDeclarations: [], thrownErrorTypes: [] };
          const unit: Unit = {
            id: unitId,
            kind: "method",
            target: className,
            operation: methodName,
            file: relFile,
            line: lineOf(sf, member.getStart(sf)),
            endLine: lineOf(sf, member.getEnd()),
            referencedBy: referencers,
            summary: doc?.summary ?? "",
            ...(doc?.remarks ? { remarks: doc.remarks } : {}),
            params: paramsOf(host, member, doc),
            returns: returnsOf(host, member),
            uses: doc?.uses ?? [],
            modifies: doc?.modifies ?? [],
            injectedPorts: injected,
            portCalls: [...scan.portCalls].flatMap(([port, members]) =>
              [...members].map(([m, count]) => ({ port, member: m, count })),
            ),
            operationCalls: [],
            envInputs: member.body ? collectEnvInputs(member.body, sf, config.envInputs.forbid) : [],
            implHash: textHash(member.body ? member.body.getText(sf) : ""),
            guarantees: doc ? buildGuarantees(unitId, doc, docLine) : [],
            examples: (doc?.examples ?? []).map((e) => ({
              expression: e.expression,
              expected: e.expected,
              line: docLine + e.lineOffset,
            })),
            ...(doc?.supersedes ? { supersedes: doc.supersedes } : {}),
            hasDoc: doc !== undefined,
          };
          units.push({
            unit,
            doc,
            docComment: comment,
            declaration: member,
            nameNode: member.name,
            sourceFile: sf,
            calleeDeclarations: scan.calleeDeclarations,
            thrownErrorTypes: scan.thrownErrorTypes,
            importSources,
          });
        }
        continue;
      }
      if (ts.isInterfaceDeclaration(statement)) {
        const name = statement.name.text;
        if (!exported.has(name)) continue;
        const { doc, comment, docLine } = describeExtraction(ctx, sf, statement);
        recordDocMessages(doc, docLine);
        if (!doc?.isPort) continue;
        const members = memberNames(statement, sf);
        const vocabulary = [
          ...new Set(
            statement.members.flatMap((m) =>
              ts.isMethodSignature(m) ? m.parameters.map((p) => p.name.getText(sf)) : [],
            ),
          ),
        ];
        ports.push({
          name,
          file: relFile,
          line: lineOf(sf, statement.getStart(sf)),
          members,
          vocabulary,
          description: doc.summary,
        });
        if (!inSurface(name)) continue;
        const unit: Unit = {
          id: name,
          kind: "port",
          operation: name,
          file: relFile,
          line: lineOf(sf, statement.getStart(sf)),
          endLine: lineOf(sf, statement.getEnd()),
          referencedBy: referencedBy(name),
          summary: doc.summary,
          ...(doc.remarks ? { remarks: doc.remarks } : {}),
          params: [],
          returns: "",
          uses: [],
          modifies: [],
          injectedPorts: [],
          portCalls: [],
          operationCalls: [],
          envInputs: [],
          implHash: textHash(statement.getText(sf)),
          guarantees: buildGuarantees(name, doc, docLine),
          examples: [],
          hasDoc: true,
        };
        units.push({
          unit,
          doc,
          docComment: comment,
          declaration: statement,
          nameNode: statement.name,
          sourceFile: sf,
          calleeDeclarations: [],
          thrownErrorTypes: [],
          importSources,
        });
      }
    }
  }

  // Second pass: callee declarations → surface unit ids ("how" for docs, composition for resolution).
  const byDeclaration = new Map<ts.Node, string>();
  for (const u of units) byDeclaration.set(u.declaration, u.unit.id);
  for (const u of units) {
    const calls = new Set<string>();
    for (const decl of u.calleeDeclarations) {
      const id = byDeclaration.get(decl);
      if (id && id !== u.unit.id) calls.add(id);
    }
    u.unit.operationCalls = [...calls].sort();
  }
  return { units, entities, ports, docMessages };
}
