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
  describe: string;
  test: string;
  todo: (title: string) => string;
  skip: string;
}

const ADAPTERS: Record<TestAdapter, AdapterSyntax> = {
  bun: {
    imports: 'import { describe, expect, test } from "bun:test";',
    describe: "describe",
    test: "test",
    todo: (t) => `test.todo(${t});`,
    skip: "test.skip",
  },
  vitest: {
    imports: 'import { describe, expect, test } from "vitest";',
    describe: "describe",
    test: "test",
    todo: (t) => `test.todo(${t});`,
    skip: "test.skip",
  },
  jest: {
    imports: 'import { describe, expect, test } from "@jest/globals";',
    describe: "describe",
    test: "test",
    todo: (t) => `test.todo(${t});`,
    skip: "test.skip",
  },
  playwright: {
    imports: 'import { expect, test } from "@playwright/test";',
    describe: "test.describe",
    test: "test",
    todo: (t) => `test.fixme(${t}, async () => {});`,
    skip: "test.skip",
  },
};

function q(text: string): string {
  return JSON.stringify(text);
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
  const ext = config.tests.importExtension;
  if (rel.endsWith(".ts")) return ext === "" ? rel.slice(0, -3) : rel.slice(0, -3) + ext;
  return rel;
}

function title(config: Config, g: Unit["guarantees"][number]): string {
  const prefix = config.tests.prefixes[g.kind] ?? "";
  return `${g.key} ${prefix ? `${prefix} ` : ""}${g.text}`.trim();
}

function isClock(type: string): boolean {
  return /clock/i.test(type);
}

function isTxRunner(type: string, members: readonly string[]): boolean {
  return (
    /transaction|txrunner|unitofwork/i.test(type) ||
    members.some((m) => /^(run|execute|transaction|withTransaction)/.test(m))
  );
}

interface Arrangement {
  imports: string[];
  lines: string[];
  sutExpr: string;
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
    for (const port of unit.injectedPorts) {
      const typeName = port.type.replace(/<.*$/, "");
      const source = ex.importSources.get(typeName);
      const spec = source ? importSpecifier(testFile, source, sourceAbs, config) : sutSpecifier;
      if (!typeImports.has(spec)) typeImports.set(spec, new Set());
      typeImports.get(spec)?.add(typeName);
      if (isClock(typeName)) {
        runtimeImports.add("fakeClock");
        lines.push(`const ${port.member} = fakeClock();`);
      } else if (isTxRunner(typeName, port.members)) {
        runtimeImports.add("createFaultRunner");
        lines.push(`const ${port.member} = createFaultRunner<${typeName}>([${port.members.map(q).join(", ")}]);`);
        txName = port.member;
      } else {
        runtimeImports.add("createStub");
        lines.push(`const ${port.member} = createStub<${typeName}>([${port.members.map(q).join(", ")}]);`);
        stubNames.push(port.member);
      }
    }
    for (const [spec, names] of typeImports)
      imports.push(`import type { ${[...names].sort().join(", ")} } from ${q(spec)};`);
    lines.push(`const sut = new ${unit.target}(${unit.injectedPorts.map((p) => p.member).join(", ")});`);
    return finish(`sut.${unit.operation}`);
  }
  if (unit.kind === "function") {
    imports.push(`import { ${unit.operation} } from ${q(sutSpecifier)};`);
    for (const p of unit.params) {
      if (isClock(p.type)) {
        runtimeImports.add("fakeClock");
        lines.push(`const ${p.name} = fakeClock();`);
      }
    }
    return finish(unit.operation);
  }
  return finish(unit.operation);

  function finish(sutExpr: string): Arrangement {
    if (runtimeImports.size > 0)
      imports.unshift(`import { ${[...runtimeImports].sort().join(", ")} } from "specgate/runtime";`);
    return { imports, lines, sutExpr, stubNames, txName };
  }
}

function callArgs(unit: Unit): string {
  return unit.params.map((p) => `/* ${p.name}: ${p.type} */ undefined`).join(", ");
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
  const t = q(title(config, g));
  if (g.source === "throws" && g.throws) {
    const expectation = isAsync(unit)
      ? `await expect(${call}).rejects.toThrow(${g.throws});`
      : `expect(() => ${call}).toThrow(${g.throws});`;
    return {
      kind: "test",
      code: `  ${syntax.test}(${t}, ${asyncKw}() => {\n    // arrange: TODO make the condition hold — ${g.text}\n    ${expectation}\n  });`,
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
      code: `  ${syntax.test}(${t}, ${asyncKw}() => {\n    // arrange: TODO make a successful call possible\n    const before = snapshotAll({ ${names.join(", ")} });\n    ${isAsync(unit) ? "await " : ""}${call};\n    // ports outside @modifies must not have been written; with stubs this means "not called"\n    expect(snapshotAll({ ${names.join(", ")} })).toEqual(before);\n  });`,
    };
  }
  if (g.kind === "atomic" && unit.kind === "method" && arr.txName) {
    const observed = arr.stubNames;
    if (observed.length === 0) return undefined;
    return {
      kind: "skip",
      code: `  // atomicity needs contract-passing fakes with real state; stubs only record calls. Replace the stubs, then un-skip.\n  ${syntax.skip}(${t}, async () => {\n    await ${call}; // warm-up: counts transaction boundaries\n    for (const k of faultRunnerControl(${arr.txName}).failurePoints()) {\n      for (const s of [${observed.join(", ")}]) stubReset(s);\n      faultRunnerControl(${arr.txName}).failAt(k);\n      const before = snapshotAll({ ${observed.join(", ")} });\n      await expect(${call}).rejects.toThrow();\n      expect(snapshotAll({ ${observed.join(", ")} })).toEqual(before);\n    }\n  });`,
    };
  }
  if (g.kind === "idempotent" && unit.kind === "method" && arr.stubNames.length > 0) {
    const names = arr.stubNames;
    return {
      kind: "skip",
      code: `  // idempotence compares port state after one and two calls; needs contract-passing fakes. Replace the stubs, then un-skip.\n  ${syntax.skip}(${t}, async () => {\n    await ${call};\n    const once = snapshotAll({ ${names.join(", ")} });\n    await ${call};\n    expect(snapshotAll({ ${names.join(", ")} })).toEqual(once);\n  });`,
    };
  }
  return undefined;
}

function renderNewFile(unit: Unit, ex: ExtractedUnit, testFile: string, config: Config): string {
  const syntax = ADAPTERS[config.tests.adapter];
  const arr = arrange(unit, ex, testFile, config);
  const imports = new Set<string>([syntax.imports, ...arr.imports]);
  const tests: string[] = [];
  let needsRuntime: string[] = [];
  for (const g of unit.guarantees) {
    if (!g.id || g.id === config.ids.placeholder) continue;
    if (g.source === "throws" && g.throws) {
      const imp = errorImport(unit, ex, g.throws, testFile, config);
      if (imp) imports.add(imp);
    }
    const body = testBody(unit, g, arr, syntax, config);
    if (body) {
      tests.push(body.code);
      if (/snapshotAll/.test(body.code)) needsRuntime.push("snapshotAll");
      if (/faultRunnerControl/.test(body.code)) needsRuntime.push("faultRunnerControl", "stubReset");
    } else {
      tests.push(`  ${syntax.todo(q(title(config, g)))}`);
    }
  }
  needsRuntime = [...new Set(needsRuntime)].sort();
  if (needsRuntime.length > 0) {
    const existing = [...imports].find((i) => i.includes('"specgate/runtime"'));
    const names = new Set(needsRuntime);
    if (existing) {
      imports.delete(existing);
      for (const n of existing.replace(/^import \{ | \} from .*$/g, "").split(", ")) names.add(n);
    }
    imports.add(`import { ${[...names].sort().join(", ")} } from "specgate/runtime";`);
  }
  const rank = (i: string): number =>
    i === syntax.imports ? 0 : i.startsWith("import type") ? 3 : /from "\./.test(i) ? 2 : 1;
  const sorted = [...imports].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const header = [
    "// Generated by specgate gen. Edit freely: existing tests are never rewritten, missing guarantees are appended.",
    ...sorted,
    "",
    `${syntax.describe}(${q(unit.id)}, () => {`,
    ...arr.lines.map((l) => `  ${l}`),
    arr.lines.length > 0 ? "" : undefined,
    ...tests,
    "});",
    "",
  ].filter((l): l is string => l !== undefined);
  return header.join("\n");
}

function renderAppend(unit: Unit, missing: Unit["guarantees"], config: Config, now: Date): string {
  const syntax = ADAPTERS[config.tests.adapter];
  const lines = [
    "",
    `// specgate gen (${now.toISOString().slice(0, 10)}): guarantees without a test. Move them into the describe above as you implement them.`,
    `${syntax.describe}(${q(`${unit.id} (specgate)`)}, () => {`,
    ...missing.map((g) => `  ${syntax.todo(q(title(config, g)))}`),
    "});",
    "",
  ];
  return lines.join("\n");
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
    'import { acceptsAgain, arbitraryFromZod } from "specgate/runtime";',
    `import { ${withInvariants.map((e) => e.name).join(", ")} } from ${q(relativeImport(testFile, sourceAbs, config))};`,
    "",
    `${syntax.describe}(${q(`${toPosix(first.file)} invariants`)}, () => {`,
    ...withInvariants.flatMap((e) => [
      `  // ${e.name}: ${e.invariants.map((i) => i.text).join("; ")}`,
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
    for (const { unit, ex } of units) {
      const real = unit.guarantees.filter((g) => g.id && g.id !== config.ids.placeholder);
      if (real.length === 0) continue;
      if (!existsSync(testFile)) {
        record(testFile, "created", renderNewFile(unit, ex, testFile, config));
        continue;
      }
      const existing = extractTests(config, [testFile]);
      const covered = new Set(existing.tests.map((t) => t.key));
      const missing = real.filter((g) => !covered.has(g.key));
      if (missing.length === 0) {
        record(testFile, "unchanged", readFileSync(testFile, "utf8"));
        continue;
      }
      const content = readFileSync(testFile, "utf8").replace(/\s*$/, "\n") + renderAppend(unit, missing, config, now);
      record(testFile, "appended", content);
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
