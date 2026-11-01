import { dirname, resolve } from "node:path";
import ts from "typescript";
import { fileExists } from "../util/paths.ts";

/**
 * The only module that touches the TypeScript type checker.
 *
 * @remarks
 * Public-surface detection ("is this export referenced from another module?") and identifier
 * resolution need type information, which syntax-only parsers do not provide. Keeping every
 * checker call behind this module lets the checker be swapped (for example for the native
 * TypeScript port once its API is stable) without touching extractors or rules.
 */
export interface ProgramHost {
  readonly root: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** Project source files: not declaration files, not under node_modules. */
  readonly files: readonly ts.SourceFile[];
  typeToString(node: ts.Node): string;
  typeNodeToString(type: ts.TypeNode | undefined, fallbackNode: ts.Node): string;
  /** Names exported from a module, resolved to their local declaration nodes. */
  exportsOf(file: ts.SourceFile): Map<string, ts.Declaration[]>;
  /** Declarations the identifier ultimately refers to, following import aliases. */
  declarationsOf(node: ts.Node): ts.Declaration[];
  /** Every exported type-like name (class, interface, type alias, enum), enum member and string-literal union member in the program. */
  programTypeNames(): ReadonlySet<string>;
  /** Property and method names of the type a node has. */
  membersOf(node: ts.Node): string[];
  /** Whether a class or interface named `typeName` anywhere in the program declares a public member `member`. */
  hasPublicMember(typeName: string, member: string): boolean;
}

function parseTsconfig(root: string, tsconfigPath: string): ts.ParsedCommandLine | undefined {
  const configPath = resolve(root, tsconfigPath);
  if (!fileExists(configPath)) return undefined;
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  };
  return ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
}

/**
 * Creates a program from the repo's tsconfig, adding `extraRootFiles` (surface and test files)
 * so that files outside the tsconfig's `include` still take part. Without a tsconfig a
 * permissive default is used so that `check` can run on an unconfigured repo.
 */
export function createProgramHost(
  root: string,
  tsconfigPath: string,
  extraRootFiles: readonly string[] = [],
): ProgramHost {
  const parsed = parseTsconfig(root, tsconfigPath);
  const options: ts.CompilerOptions = parsed?.options ?? {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    allowJs: false,
    skipLibCheck: true,
    noEmit: true,
  };
  const rootNames = Array.from(new Set([...(parsed?.fileNames ?? []), ...extraRootFiles]));
  const { tsBuildInfoFile: _ignoredBuildInfo, ...baseOptions } = options;
  const program = ts.createProgram({
    rootNames,
    options: {
      ...baseOptions,
      noEmit: true,
      skipLibCheck: true,
      composite: false,
      incremental: false,
      declaration: false,
    },
    ...(parsed?.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
  const checker = program.getTypeChecker();
  const files = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));

  let typeNames: Set<string> | undefined;
  let publicMembers: Map<string, Set<string>> | undefined;
  const collectPublicMembers = (): Map<string, Set<string>> => {
    const map = new Map<string, Set<string>>();
    for (const sf of files) {
      const visit = (node: ts.Node): void => {
        if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
          const set = map.get(node.name.text) ?? new Set<string>();
          for (const member of node.members) {
            if (!member.name || ts.isPrivateIdentifier(member.name)) continue;
            if (
              ts.isClassElement(member) &&
              (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0
            )
              continue;
            set.add(member.name.getText(sf));
          }
          map.set(node.name.text, set);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return map;
  };

  const host: ProgramHost = {
    root,
    program,
    checker,
    files,
    typeToString(node) {
      const type = checker.getTypeAtLocation(node);
      return checker.typeToString(
        type,
        node,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
    },
    typeNodeToString(type, fallbackNode) {
      if (type) return type.getText();
      return host.typeToString(fallbackNode);
    },
    exportsOf(file) {
      const out = new Map<string, ts.Declaration[]>();
      const moduleSymbol = checker.getSymbolAtLocation(file);
      if (!moduleSymbol) return out;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const resolved = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        out.set(exported.name, resolved.declarations ?? []);
      }
      return out;
    },
    declarationsOf(node) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) return [];
      const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return resolved.declarations ?? [];
    },
    programTypeNames() {
      if (typeNames) return typeNames;
      const names = new Set<string>();
      for (const sf of files) {
        const visit = (node: ts.Node): void => {
          if (
            (ts.isClassDeclaration(node) ||
              ts.isInterfaceDeclaration(node) ||
              ts.isTypeAliasDeclaration(node) ||
              ts.isEnumDeclaration(node)) &&
            node.name
          ) {
            names.add(node.name.text);
            if (ts.isEnumDeclaration(node)) for (const member of node.members) names.add(member.name.getText(sf));
          }
          if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) names.add(node.literal.text);
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            // `export const Status = { DONE: "DONE" } as const` enum-like objects
            const literal = stripAsConst(node.initializer);
            if (ts.isObjectLiteralExpression(literal)) {
              names.add(node.name.text);
              for (const prop of literal.properties) if (prop.name) names.add(prop.name.getText(sf));
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
      typeNames = names;
      return names;
    },
    hasPublicMember(typeName, member) {
      publicMembers ??= collectPublicMembers();
      return publicMembers.get(typeName)?.has(member) ?? false;
    },
    membersOf(node) {
      const type = checker.getTypeAtLocation(node);
      return type
        .getProperties()
        .map((p) => p.name)
        .filter((n) => !n.startsWith("__"));
    },
  };
  return host;
}

function stripAsConst(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))
    current = current.expression;
  return current;
}

export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** The `/** ... *\/` comment immediately preceding `node`, if any. */
export function docCommentOf(sf: ts.SourceFile, node: ts.Node): { pos: number; end: number; text: string } | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i];
    if (!range) continue;
    const text = sf.text.slice(range.pos, range.end);
    if (text.startsWith("/**") && !text.startsWith("/***")) return { pos: range.pos, end: range.end, text };
  }
  return undefined;
}

export function projectDir(root: string, tsconfigPath: string): string {
  return dirname(resolve(root, tsconfigPath));
}
