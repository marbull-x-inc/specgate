import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Config, TestAdapter } from "../config/schema.ts";
import type { ExtractedUnit } from "../extract/surface.ts";
import { extractTests } from "../extract/tests/index.ts";
import type { Entity, Unit } from "../ir/schema.ts";
import { toPosix } from "../util/paths.ts";

/**
 * Generates test skeletons from guarantees.
 *
 * @remarks
 * Only what the signature, the tags and the Zod schemas determine is written; nothing is
 * guessed from prose. One `test()` per guarantee, titled with the guarantee key so that
 * `check` links it. Files people edit (`*.test.ts`) are only ever appended to: existing tests
 * are never rewritten and missing guarantees are added at the end, so running `gen` twice is
 * a no-op. Fully automatic files (`*.doctest.test.ts`, `*.property.test.ts`) are overwritten
 * each run and are not meant to be edited.
 */
export interface GenOptions {
  dryRun?: boolean;
  unitFilter?: string;
  now?: Date;
}

export interface GenResult {
  written: Array<{ path: string; action: "created" | "appended" | "overwritten" | "unchanged"; content: string }>;
}

interface AdapterSyntax {
  imports: string;
  /** Module the framework import comes from, to detect an existing import when appending. */
  frameworkModule: string;
  describe: string;
  test: string;
  todo: (title: string) => string;
  todoWrapped: (title: string) => string[];
  skip: string;
}

const ADAPTERS: Record<TestAdapter, AdapterSyntax> = {
  bun: {
    imports: 'import { describe, expect, test } from "bun:test";',
    frameworkModule: "bun:test",
    describe: "describe",
    test: "test",
    // bun-types before 1.4.4 type `test.todo` as requiring the callback.
    todo: (t) => `test.todo(${t}, () => {});`,
    todoWrapped: (t) => ["test.todo(", `  ${t},`, "  () => {},", ");"],
    skip: "test.skip",
  },
  vitest: {
    imports: 'import { describe, expect, test } from "vitest";',
    frameworkModule: "vitest",
    describe: "describe",
    test: "test",
    todo: (t) => `test.todo(${t});`,
    todoWrapped: (t) => ["test.todo(", `  ${t},`, ");"],
    skip: "test.skip",
  },
  jest: {
    imports: 'import { describe, expect, test } from "@jest/globals";',
    frameworkModule: "@jest/globals",
    describe: "describe",
    test: "test",
    todo: (t) => `test.todo(${t});`,
    todoWrapped: (t) => ["test.todo(", `  ${t},`, ");"],
    skip: "test.skip",
  },
  playwright: {
    imports: 'import { expect, test } from "@playwright/test";',
    frameworkModule: "@playwright/test",
    describe: "test.describe",
    test: "test",
    todo: (t) => `test.fixme(${t}, async () => {});`,
    todoWrapped: (t) => ["test.fixme(", `  ${t},`, "  async () => {},", ");"],
    skip: "test.skip",
  },
};

/**
 * A string literal for generated source. JSON escaping covers quotes, backslashes and control
 * characters; U+2028 / U+2029 are escaped too, since they end a line for some tools and readers
 * even where the language accepts them inside a string.
 */
function q(text: string): string {
  return JSON.stringify(text)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Text for a generated `//` comment: on one line (any line break, including U+2028 / U+2029,
 * becomes a space), so text from a doc comment can never end the comment and become code.
 */
function commentText(text: string): string {
  return text
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mirrorPath(config: Config, sourceFile: string, suffix = config.tests.mirror.suffix): string {
  const { from, to } = config.tests.mirror;
  const rel = toPosix(sourceFile).replace(/\.tsx?$/, "");
  const prefix = `${from.replace(/\/$/, "")}/`;
  const inside = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
  return resolve(config.root, to, `${inside}${suffix}`);
}

function importSpecifier(fromTestFile: string, sourceSpecifier: string, sourceFileAbs: string, config: Config): string {
  if (!sourceSpecifier.startsWith(".")) return sourceSpecifier;
  const targetAbs = resolve(dirname(sourceFileAbs), sourceSpecifier);
  return relativeImport(fromTestFile, targetAbs, config);
}

function relativeImport(fromTestFile: string, targetAbs: string, config: Config): string {
  let rel = toPosix(relative(dirname(fromTestFile), targetAbs));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  // The target may be a source path (`x.ts`) or an import specifier with or without an
  // extension (`./x.service`, `./x.js`); either way the configured extension is applied.
  const bare = rel.replace(/\.(?:[mc]?ts|[mc]?js|tsx|jsx)$/, "");
  return bare + config.tests.importExtension;
}

/** `<prefix> <key> <statement>`: the configured category prefix first, so repository title rules still hold. */
function title(config: Config, g: Unit["guarantees"][number]): string {
  const prefix = config.tests.prefixes[g.kind] ?? "";
  return `${prefix ? `${prefix} ` : ""}${g.key} ${g.text}`.trim();
}

/** A todo line, wrapped the way common formatters do when it would exceed `tests.lineWidth`. */
function todoLines(syntax: AdapterSyntax, text: string, config: Config): string[] {
  const single = `  ${syntax.todo(q(text))}`;
  if (single.length <= config.tests.lineWidth) return [single];
  return syntax.todoWrapped(q(text)).map((l) => `  ${l}`);
}

function localDate(now: Date): string {
  const shifted = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function isClock(type: string): boolean {
  return /clock/i.test(type);
}

const TX_TYPE = /transaction|txrunner|unitofwork/i;
const TX_MEMBER = /^(run|transaction|withTransaction|runInTransaction)$/;

/**
 * The injected member that runs transactions: by type name first; by an exactly named public
 * method only when no type name says so. At most one, so a service that merely depends on a
 * runner (and has `execute`) is never taken for the runner.
 */
function txRunnerMember(ports: Unit["injectedPorts"]): string | undefined {
  const byName = ports.find((p) => TX_TYPE.test(p.type.replace(/<.*$/, "")));
  if (byName) return byName.member;
  return ports.find((p) => p.members.some((m) => TX_MEMBER.test(m)))?.member;
}

/** `const name = call<T>([...]);`, broken one element per line when it exceeds the width. */
function memberListLine(head: string, members: readonly string[], config: Config): string[] {
  const single = `${head}[${members.map(q).join(", ")}]);`;
  if (single.length + 4 <= config.tests.lineWidth || members.length === 0) return [single];
  return [`${head}[`, ...members.map((m) => `  ${q(m)},`), "]);"];
}

interface Arrangement {
  imports: string[];
  lines: string[];
  sutExpr: string;
  /** Type expression of the callable, for `Parameters<...>`. */
  sutType: string;
  stubNames: string[];
  txName: string | undefined;
}

function arrange(unit: Unit, ex: ExtractedUnit, testFile: string, config: Config): Arrangement {
  const imports: string[] = [];
  const lines: string[] = [];
  const stubNames: string[] = [];
  let txName: string | undefined;
  const runtimeImports = new Set<string>();
  const sourceAbs = resolve(config.root, unit.file);
  const sutSpecifier = relativeImport(testFile, sourceAbs, config);

  if (unit.kind === "method" && unit.target) {
    imports.push(`import { ${unit.target} } from ${q(sutSpecifier)};`);
    const typeImports = new Map<string, Set<string>>();
    const txMember = txRunnerMember(unit.injectedPorts);
    for (const port of unit.injectedPorts) {
      const typeName = port.type.replace(/<.*$/, "");
      const source = ex.importSources.get(typeName);
      const spec = source ? importSpecifier(testFile, source, sourceAbs, config) : sutSpecifier;
      if (!typeImports.has(spec)) typeImports.set(spec, new Set());
      typeImports.get(spec)?.add(typeName);
      if (isClock(typeName)) {
        runtimeImports.add("fakeClock");
        lines.push(`const ${port.member} = fakeClock();`);
      } else if (port.member === txMember) {
        runtimeImports.add("createFaultRunner");
        lines.push(...memberListLine(`const ${port.member} = createFaultRunner<${typeName}>(`, port.members, config));
        txName = port.member;
      } else {
        runtimeImports.add("createStub");
        lines.push(...memberListLine(`const ${port.member} = createStub<${typeName}>(`, port.members, config));
        stubNames.push(port.member);
      }
    }
    for (const [spec, names] of typeImports)
      imports.push(`import type { ${[...names].sort().join(", ")} } from ${q(spec)};`);
    lines.push(`const sut = new ${unit.target}(${unit.injectedPorts.map((p) => p.member).join(", ")});`);
    return finish(`sut.${unit.operation}`, `${unit.target}[${q(unit.operation)}]`);
  }
  if (unit.kind === "function") {
    imports.push(`import { ${unit.operation} } from ${q(sutSpecifier)};`);
    for (const p of unit.params) {
      if (isClock(p.type)) {
        runtimeImports.add("fakeClock");
        lines.push(`const ${p.name} = fakeClock();`);
      }
    }
    return finish(unit.operation, `typeof ${unit.operation}`);
  }
  return finish(unit.operation, `typeof ${unit.operation}`);

  function finish(sutExpr: string, sutType: string): Arrangement {
    if (runtimeImports.size > 0)
      imports.unshift(`import { ${[...runtimeImports].sort().join(", ")} } from "@marbull-x-inc/specgate/runtime";`);
    return { imports, lines, sutExpr, sutType, stubNames, txName };
  }
}

/**
 * Arguments are left to the author, typed: `todoArgs` returns the operation's parameter tuple
 * and throws when called, so the skeleton compiles under `strict` and a test fails with "fill in
 * the arguments" until someone does, instead of passing `undefined` where a value is typed.
 */
function argsLine(unit: Unit, sutType: string): string | undefined {
  if (unit.params.length === 0) return undefined;
  return `const args = todoArgs<Parameters<${sutType}>>([${unit.params.map((p) => q(p.name)).join(", ")}]);`;
}

function callArgs(unit: Unit): string {
  return unit.params.length === 0 ? "" : "...args";
}

function isAsync(unit: Unit): boolean {
  return /^Promise</.test(unit.returns);
}

function errorImport(
  unit: Unit,
  ex: ExtractedUnit,
  errorType: string,
  testFile: string,
  config: Config,
): string | undefined {
  if (["Error", "RangeError", "TypeError", "SyntaxError"].includes(errorType)) return undefined;
  const source = ex.importSources.get(errorType);
  const sourceAbs = resolve(config.root, unit.file);
  const spec = source
    ? importSpecifier(testFile, source, sourceAbs, config)
    : relativeImport(testFile, sourceAbs, config);
  return `import { ${errorType} } from ${q(spec)};`;
}

/** Builds the body for one guarantee; returns `undefined` when only a todo can be emitted. */
function testBody(
  unit: Unit,
  g: Unit["guarantees"][number],
  arr: Arrangement,
  syntax: AdapterSyntax,
  config: Config,
): { code: string; kind: "test" | "skip" } | undefined {
  const asyncKw = isAsync(unit) ? "async " : "";
  const call = `${arr.sutExpr}(${callArgs(unit)})`;
  // Computed before the call (never inside `expect(() => …)`), so its throw cannot satisfy toThrow.
  const argsDecl = argsLine(unit, arr.sutType);
  const args = argsDecl ? `\n    ${argsDecl}` : "";
  const t = q(title(config, g));
  if (g.source === "throws" && g.throws) {
    const expectation = isAsync(unit)
      ? `await expect(${call}).rejects.toThrow(${g.throws});`
      : `expect(() => ${call}).toThrow(${g.throws});`;
    return {
      kind: "test",
      code: `  ${syntax.test}(${t}, ${asyncKw}() => {${args}\n    // arrange: TODO make the condition hold — ${commentText(g.text)}\n    ${expectation}\n  });`,
    };
  }
  if (g.kind === "frame" && unit.kind === "method") {
    const declared = new Set([...unit.uses, ...unit.modifies]);
    const outside = unit.injectedPorts.filter(
      (p) =>
        !declared.has(p.type) && !declared.has(p.type.replace(/^I(?=[A-Z])/, "")) && arr.stubNames.includes(p.member),
    );
    const untouched =
      outside.length > 0
        ? outside
        : unit.injectedPorts.filter((p) => !unit.modifies.includes(p.type) && arr.stubNames.includes(p.member));
    if (untouched.length === 0) return undefined;
    const names = untouched.map((p) => p.member);
    return {
      kind: "test",
      code: `  ${syntax.test}(${t}, ${asyncKw}() => {${args}\n    // arrange: TODO make a successful call possible\n    const before = snapshotAll({ ${names.join(", ")} });\n    ${isAsync(unit) ? "await " : ""}${call};\n    // ports outside @modifies must not have been written; with stubs this means "not called"\n    expect(snapshotAll({ ${names.join(", ")} })).toEqual(before);\n  });`,
    };
  }
  if (g.kind === "atomic" && unit.kind === "method" && arr.txName) {
    const observed = arr.stubNames;
    if (observed.length === 0) return undefined;
    return {
      kind: "skip",
      code: `  // atomicity needs contract-passing fakes with real state; stubs only record calls.\n  // Replace the stubs, then un-skip.\n  ${syntax.skip}(${t}, async () => {${args}\n    await ${call}; // warm-up: counts transaction boundaries\n    for (const k of faultRunnerControl(${arr.txName}).failurePoints()) {\n      for (const s of [${observed.join(", ")}]) stubReset(s);\n      faultRunnerControl(${arr.txName}).failAt(k);\n      const before = snapshotAll({ ${observed.join(", ")} });\n      await expect(${call}).rejects.toThrow();\n      expect(snapshotAll({ ${observed.join(", ")} })).toEqual(before);\n    }\n  });`,
    };
  }
  if (g.kind === "idempotent" && unit.kind === "method" && arr.stubNames.length > 0) {
    const names = arr.stubNames;
    return {
      kind: "skip",
      code: `  // idempotence compares port state after one and two calls; needs contract-passing fakes.\n  // Replace the stubs, then un-skip.\n  ${syntax.skip}(${t}, async () => {${args}\n    await ${call};\n    const once = snapshotAll({ ${names.join(", ")} });\n    await ${call};\n    expect(snapshotAll({ ${names.join(", ")} })).toEqual(once);\n  });`,
    };
  }
  return undefined;
}

interface RenderedUnit {
  /** Import lines (framework first, then packages, relative, types). */
  imports: string[];
  /** Arrangement lines (stubs, sut) to place at the top of the describe block. */
  arrangeLines: string[];
  /** One entry per guarantee: the test, skip or todo lines. */
  tests: string[][];
}

/** Renders the tests for the given guarantees; shared by new files and appends. */
function renderUnit(
  unit: Unit,
  ex: ExtractedUnit,
  guarantees: readonly Unit["guarantees"][number][],
  testFile: string,
  config: Config,
): RenderedUnit {
  const syntax = ADAPTERS[config.tests.adapter];
  const arr = arrange(unit, ex, testFile, config);
  const imports = new Set<string>([syntax.imports, ...arr.imports]);
  const tests: string[][] = [];
  let needsRuntime: string[] = [];
  for (const g of guarantees) {
    if (!g.id || g.id === config.ids.placeholder) continue;
    if (g.source === "throws" && g.throws) {
      const imp = errorImport(unit, ex, g.throws, testFile, config);
      if (imp) imports.add(imp);
    }
    const body = testBody(unit, g, arr, syntax, config);
    if (body) {
      tests.push(body.code.split("\n"));
      if (/snapshotAll/.test(body.code)) needsRuntime.push("snapshotAll");
      if (/faultRunnerControl/.test(body.code)) needsRuntime.push("faultRunnerControl", "stubReset");
      if (/todoArgs</.test(body.code)) needsRuntime.push("todoArgs");
    } else {
      tests.push(todoLines(syntax, title(config, g), config));
    }
  }
  needsRuntime = [...new Set(needsRuntime)].sort();
  if (needsRuntime.length > 0) {
    const existing = [...imports].find((i) => i.includes('"@marbull-x-inc/specgate/runtime"'));
    const names = new Set(needsRuntime);
    if (existing) {
      imports.delete(existing);
      for (const n of existing.replace(/^import \{ | \} from .*$/g, "").split(", ")) names.add(n);
    }
    imports.add(`import { ${[...names].sort().join(", ")} } from "@marbull-x-inc/specgate/runtime";`);
  }
  const rank = (i: string): number =>
    i === syntax.imports ? 0 : i.startsWith("import type") ? 3 : /from "\./.test(i) ? 2 : 1;
  return {
    imports: [...imports].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
    arrangeLines: arr.lines,
    tests,
  };
}

/**
 * A new test file for every unit of one source file at once: one import block (named imports
 * from the same module merged) and one `describe` per unit, so a first run does not read like a
 * series of appends.
 */
function renderNewFile(
  entries: ReadonlyArray<{ unit: Unit; ex: ExtractedUnit; guarantees: Unit["guarantees"] }>,
  testFile: string,
  config: Config,
): string {
  const syntax = ADAPTERS[config.tests.adapter];
  const rendered = entries.map((e) => ({ unit: e.unit, r: renderUnit(e.unit, e.ex, e.guarantees, testFile, config) }));
  const lines: Array<string | undefined> = [
    "// Generated by specgate gen. Edit freely: existing tests are never rewritten,",
    "// missing guarantees are appended.",
    ...mergeImports(rendered.flatMap(({ r }) => r.imports)).map((line) => wrapImport(line, config)),
  ];
  for (const { unit, r } of rendered) {
    lines.push(
      "",
      `${syntax.describe}(${q(unit.id)}, () => {`,
      ...r.arrangeLines.map((l) => `  ${l}`),
      r.arrangeLines.length > 0 ? "" : undefined,
      ...r.tests.flat(),
      "});",
    );
  }
  lines.push("");
  return lines.filter((l): l is string => l !== undefined).join("\n");
}

/** An import statement, broken one name per line (as formatters do) when it exceeds the width. */
function wrapImport(line: string, config: Config): string {
  if (line.length <= config.tests.lineWidth) return line;
  const m = /^import (type )?\{ ([^}]+) \} from ("[^"]+");$/.exec(line);
  if (!m) return line;
  const names = (m[2] ?? "").split(", ");
  return [`import ${m[1] ?? ""}{`, ...names.map((n) => `  ${n},`), `} from ${m[3]};`].join("\n");
}

/** Merges `import { a } from "m"` lines that share a module (and `type`-ness); other lines are kept once. */
function mergeImports(lines: readonly string[]): string[] {
  const named = new Map<string, { prefix: string; module: string; names: string[] }>();
  const out: Array<string | { key: string }> = [];
  for (const line of lines) {
    const m = /^import (type )?\{ ([^}]+) \} from ("[^"]+");$/.exec(line);
    if (!m) {
      if (!out.includes(line)) out.push(line);
      continue;
    }
    const key = `${m[1] ?? ""}${m[3]}`;
    const entry = named.get(key);
    const names = (m[2] ?? "").split(", ");
    if (entry) {
      for (const n of names) if (!entry.names.includes(n)) entry.names.push(n);
    } else {
      named.set(key, { prefix: m[1] ?? "", module: m[3] ?? "", names: [...names] });
      out.push({ key });
    }
  }
  return out.map((item) => {
    if (typeof item === "string") return item;
    const e = named.get(item.key);
    return e ? `import ${e.prefix}{ ${e.names.join(", ")} } from ${e.module};` : "";
  });
}

// Either quote style: the file may have been reformatted by the project's formatter.
const IMPORT_STATEMENT = /^import\s[^;]*?from\s+(["'])([^"']+)\1;?$/gm;

interface ExistingImports {
  /** Names bound as values (usable in `new X()` and `expect(...).toThrow(X)`). */
  names: Set<string>;
  /** Names bound only as types (`import type { X }` or `import { type X }`). */
  typeOnly: Set<string>;
  modules: Set<string>;
}

/** Names already bound by import statements in `content`, and the modules imported from. */
function existingImports(content: string): ExistingImports {
  const names = new Set<string>();
  const typeOnly = new Set<string>();
  const modules = new Set<string>();
  for (const m of content.matchAll(IMPORT_STATEMENT)) {
    modules.add(m[2] ?? "");
    const wholeType = /^import\s+type\s/.test(m[0]);
    const clause = m[0].replace(/^import\s+(type\s+)?/, "").replace(/\s+from\s+["'][^"']+["'];?$/, "");
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces?.[1]) {
      for (const part of braces[1].split(",")) {
        const trimmed = part.trim();
        const name = trimmed
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (!name) continue;
        if (wholeType || /^type\s/.test(trimmed)) typeOnly.add(name);
        else names.add(name);
      }
    }
    const defaultName = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(clause.replace(/\{[^}]*\}/, ""));
    if (defaultName?.[1]) (wholeType ? typeOnly : names).add(defaultName[1]);
  }
  for (const n of names) typeOnly.delete(n);
  return { names, typeOnly, modules };
}

/**
 * Removes `names` from type-only import statements, so that a value import of the same name can
 * be added without a duplicate binding. A statement left empty is dropped.
 */
function dropTypeOnly(content: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return content;
  return content.replace(IMPORT_STATEMENT, (statement) => {
    const m = /^import(\s+type)?\s*\{([^}]*)\}(\s*from\s*.*)$/s.exec(statement);
    if (!m) return statement;
    const wholeType = m[1] !== undefined;
    const parts = (m[2] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const kept = parts.filter((p) => {
      const isType = wholeType || /^type\s/.test(p);
      const local =
        p
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? "";
      return !(isType && names.has(local));
    });
    if (kept.length === parts.length) return statement;
    if (kept.length === 0) return "";
    return `import${m[1] ?? ""} { ${kept.join(", ")} }${m[3] ?? ""}`;
  });
}

/** Reduces an import line to the names the file does not bind yet; `undefined` when none remain. */
function missingImport(line: string, existing: ExistingImports, frameworkModule: string): string | undefined {
  const m = /^import (type )?\{ ([^}]+) \} from ("[^"]+");$/.exec(line);
  if (!m) return existing.modules.size === 0 ? line : undefined;
  const module = (m[3] ?? "").slice(1, -1);
  if (module === frameworkModule && existing.modules.has(module)) return undefined;
  // A type import is satisfied by either kind of binding; a value import only by a value binding.
  const isType = m[1] !== undefined;
  const names = (m[2] ?? "").split(", ").filter((n) => !existing.names.has(n) && !(isType && existing.typeOnly.has(n)));
  if (names.length === 0) return undefined;
  return `import ${m[1] ?? ""}{ ${names.join(", ")} } from ${m[3]};`;
}

/**
 * Appends the tests for `missing` guarantees to an existing file with the same skeletons a new
 * file gets. Needed imports are inserted after the last import statement, minus the names the
 * file already binds; the arrangement (stubs, sut) lives inside the appended describe block so
 * it cannot clash with the file's own.
 */
function renderAppend(
  content: string,
  unit: Unit,
  ex: ExtractedUnit,
  missing: Unit["guarantees"],
  testFile: string,
  config: Config,
  now: Date,
): string {
  const syntax = ADAPTERS[config.tests.adapter];
  const rendered = renderUnit(unit, ex, missing, testFile, config);
  const existing = existingImports(content);
  const imports = rendered.imports
    .map((line) => missingImport(line, existing, syntax.frameworkModule))
    .filter((line): line is string => line !== undefined);
  // A name the file binds only as a type but the skeleton uses as a value moves to the value import.
  const promoted = new Set<string>();
  for (const line of imports) {
    const m = /^import \{ ([^}]+) \} from /.exec(line);
    for (const n of m?.[1]?.split(", ") ?? []) if (existing.typeOnly.has(n)) promoted.add(n);
  }
  let text = dropTypeOnly(content, promoted)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s*$/, "\n");
  if (imports.length > 0) {
    let lastEnd = 0;
    for (const m of text.matchAll(IMPORT_STATEMENT)) lastEnd = m.index + m[0].length;
    text =
      lastEnd > 0
        ? `${text.slice(0, lastEnd)}\n${imports.map((l) => wrapImport(l, config)).join("\n")}${text.slice(lastEnd)}`
        : `${imports.map((l) => wrapImport(l, config)).join("\n")}\n\n${text}`;
  }
  const lines = [
    "",
    `// specgate gen (${localDate(now)}): guarantees without a test.`,
    "// Move them into the describe above as you implement them.",
    `${syntax.describe}(${q(`${unit.id} (specgate)`)}, () => {`,
    ...rendered.arrangeLines.map((l) => `  ${l}`),
    rendered.arrangeLines.length > 0 ? "" : undefined,
    ...rendered.tests.flat(),
    "});",
    "",
  ].filter((l): l is string => l !== undefined);
  return text + lines.join("\n");
}

function renderDoctest(
  units: Array<{ unit: Unit; ex: ExtractedUnit }>,
  testFile: string,
  config: Config,
): string | undefined {
  const syntax = ADAPTERS[config.tests.adapter];
  const examples = units.flatMap(({ unit }) => unit.examples.map((e, i) => ({ unit, e, i })));
  if (examples.length === 0) return undefined;
  const first = units[0];
  if (!first) return undefined;
  const sourceAbs = resolve(config.root, first.unit.file);
  const names = [...new Set(units.filter(({ unit }) => unit.kind === "function").map(({ unit }) => unit.operation))];
  const lines = [
    "// Generated by specgate gen from @example lines containing `// =>`. Do not edit: this file is overwritten on every run.",
    syntax.imports,
    names.length > 0
      ? `import { ${names.join(", ")} } from ${q(relativeImport(testFile, sourceAbs, config))};`
      : undefined,
    "",
    `${syntax.describe}(${q(`${toPosix(first.unit.file)} examples`)}, () => {`,
    ...examples.map(
      ({ unit, e, i }) =>
        `  ${syntax.test}(${q(`${unit.id}.example-${i + 1} ${e.expression} // => ${e.expected}`)}, () => {\n    expect(${e.expression}).toEqual(${e.expected});\n  });`,
    ),
    "});",
    "",
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}

function renderProperty(entities: Entity[], testFile: string, config: Config): string | undefined {
  const syntax = ADAPTERS[config.tests.adapter];
  const withInvariants = entities.filter((e) => e.invariants.length > 0);
  if (withInvariants.length === 0) return undefined;
  const first = withInvariants[0];
  if (!first) return undefined;
  const sourceAbs = resolve(config.root, first.file);
  const lines = [
    "// Generated by specgate gen from @entity schemas with @invariant. Do not edit: overwritten on every run.",
    syntax.imports,
    'import * as fc from "fast-check";',
    'import { acceptsAgain, arbitraryFromZod } from "@marbull-x-inc/specgate/runtime";',
    `import { ${withInvariants.map((e) => e.name).join(", ")} } from ${q(relativeImport(testFile, sourceAbs, config))};`,
    "",
    `${syntax.describe}(${q(`${toPosix(first.file)} invariants`)}, () => {`,
    ...withInvariants.flatMap((e) => [
      `  // ${e.name}: ${commentText(e.invariants.map((i) => i.text).join("; "))}`,
      `  ${syntax.test}(${q(`${e.name}.invariant parsed values satisfy the schema again (round-trip)`)}, () => {`,
      `    // Structure and bounds come from the schema; refinements (${e.invariants.length} invariant${e.invariants.length > 1 ? "s" : ""}) are applied as a final filter.`,
      `    const arb = arbitraryFromZod(fc, ${e.name});`,
      `    fc.assert(fc.property(arb, (v) => acceptsAgain(${e.name}, v)), { numRuns: 50 });`,
      "  });",
      ...e.invariants.map((inv, i) => `  ${syntax.todo(q(`${e.name}.invariant-${i + 1} ${inv.text}`))}`),
    ]),
    "});",
    "",
  ];
  return lines.join("\n");
}

/**
 * Generates or appends tests for every unit with guarantees.
 * @returns What was written (or would be, with `dryRun`).
 */
export function generateTests(
  config: Config,
  extracted: ExtractedUnit[],
  entities: Entity[],
  options: GenOptions = {},
): GenResult {
  const now = options.now ?? new Date();
  const result: GenResult = { written: [] };
  const record = (path: string, action: GenResult["written"][number]["action"], content: string): void => {
    result.written.push({ path, action, content });
    if (options.dryRun || action === "unchanged") return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  const byFile = new Map<string, Array<{ unit: Unit; ex: ExtractedUnit }>>();
  for (const ex of extracted) {
    if (options.unitFilter && ex.unit.id !== options.unitFilter && !ex.unit.id.startsWith(`${options.unitFilter}#`))
      continue;
    const list = byFile.get(ex.unit.file) ?? [];
    list.push({ unit: ex.unit, ex });
    byFile.set(ex.unit.file, list);
  }

  for (const [file, units] of byFile) {
    const testFile = mirrorPath(config, file);
    // A guarantee is covered when any test file names it (analyze linked them across the whole
    // test set) or the mirror file already does; only the rest is generated.
    const inMirror = existsSync(testFile)
      ? new Set(extractTests(config, [testFile]).tests.map((t) => t.key))
      : new Set<string>();
    const todo = units
      .map(({ unit, ex }) => ({
        unit,
        ex,
        guarantees: unit.guarantees.filter(
          (g) => g.id && g.id !== config.ids.placeholder && g.tests.length === 0 && !inMirror.has(g.key),
        ),
      }))
      .filter((e) => e.guarantees.length > 0);
    if (!existsSync(testFile)) {
      if (todo.length > 0) record(testFile, "created", renderNewFile(todo, testFile, config));
    } else {
      let content = readFileSync(testFile, "utf8");
      for (const e of todo) content = renderAppend(content, e.unit, e.ex, e.guarantees, testFile, config, now);
      record(testFile, todo.length > 0 ? "appended" : "unchanged", content);
    }
    const doctestFile = mirrorPath(config, file, ".doctest.test.ts");
    const doctest = renderDoctest(units, doctestFile, config);
    if (doctest) record(doctestFile, existsSync(doctestFile) ? "overwritten" : "created", doctest);
    const fileEntities = entities.filter((e) => e.file === file);
    const propertyFile = mirrorPath(config, file, ".property.test.ts");
    const property = renderProperty(fileEntities, propertyFile, config);
    if (property) record(propertyFile, existsSync(propertyFile) ? "overwritten" : "created", property);
  }
  // Entities in files without units still get a property file.
  for (const entity of entities) {
    if (byFile.has(entity.file)) continue;
    if (options.unitFilter) continue;
    const propertyFile = mirrorPath(config, entity.file, ".property.test.ts");
    const property = renderProperty(
      entities.filter((e) => e.file === entity.file),
      propertyFile,
      config,
    );
    if (property && !result.written.some((w) => w.path === propertyFile))
      record(propertyFile, existsSync(propertyFile) ? "overwritten" : "created", property);
  }
  return result;
}
