import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { analyze } from "../../src/analyze.ts";
import { main } from "../../src/cli.ts";
import { defineConfig } from "../../src/config/schema.ts";
import { checkTypes, loadEntry } from "../../src/typecheck/index.ts";
import { PACKAGE_ROOT, workDir } from "../helpers/paths.ts";

/** A small ESM package: a typed merge helper, a built dist, an unmapped and a require-only entry. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "mini-merge",
    type: "module",
    exports: {
      ".": { types: "./src/index.ts", bun: "./src/index.ts", import: "./dist/index.js" },
      "./extra": "./dist/extra.js",
      "./cjs": { require: "./dist/c.cjs" },
    },
  }),
  "src/index.ts": `/**
 * Merges objects, left wins.
 * @packageDocumentation
 * @guarantee ok.esm \`import { merge } from "mini-merge"\` gives the merge function
 * @guarantee ok.require \`require("mini-merge")\` gives the merge function too
 */

/**
 * The result of merging B into A: keys of A win.
 * @guarantee ok.left-wins \`Merge<{ a: number }, { a: string; b: boolean }>\` has \`a: number\` and \`b: boolean\`
 * @guarantee err.not-object a number is not accepted for A
 */
export type Merge<A extends object, B extends object> = Omit<B, keyof A> & A;

/** Merges b into a. @guarantee ok.left-wins keys of a win */
export function merge<A extends object, B extends object>(a: A, b: B): Merge<A, B> {
  return { ...b, ...a };
}
`,
  "src/extra.ts": `/**
 * @packageDocumentation
 * @guarantee ok.extra extra things
 */
export const extra = 1;
`,
  "dist/index.js": "export function merge(a, b) { return { ...b, ...a }; }\n",
  "dist/extra.js": "export const extra = 1;\n",
  "dist/c.cjs": "module.exports = { legacy: true };\n",
};

function makePackage(): string {
  const dir = workDir("type-entry");
  for (const [name, content] of Object.entries(FILES)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: ["bun-types"],
        typeRoots: [join(PACKAGE_ROOT, "node_modules")],
        paths: {
          "@marbull-x-inc/specgate/typecheck": [join(PACKAGE_ROOT, "src", "typecheck", "index.ts")],
        },
      },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
  );
  writeFileSync(
    join(dir, "specgate.config.json"),
    JSON.stringify({
      surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
      tests: { include: ["tests/**/*.test.ts"], adapter: "bun", importExtension: ".ts" },
    }),
  );
  return dir;
}

async function reportOf(dir: string) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"], adapter: "bun" },
  });
  return (await analyze({ ...config, root: dir }, { provenance: false, baseline: null })).report;
}

describe("type and entry units", () => {
  test("extraction: kinds, keys, entries from exports, and package docs kept off the first declaration", async () => {
    const report = await reportOf(makePackage());
    const byId = new Map(report.units.map((u) => [u.id, u]));
    expect(byId.get("Merge")?.kind).toBe("type");
    expect(byId.get("Merge")?.guarantees.map((g) => g.key)).toEqual(["Merge.ok.left-wins", "Merge.err.not-object"]);
    expect(byId.get("Merge")?.typeText).toStartWith("type Merge<A extends object, B extends object>");
    const entry = byId.get("entry#main");
    expect(entry?.kind).toBe("entry");
    expect(entry?.entry).toMatchObject({ subpath: ".", source: "src/index.ts" });
    expect(entry?.guarantees.map((g) => g.key)).toEqual(["entry#main.ok.esm", "entry#main.ok.require"]);
    // the module comment documents the entry, not the declaration after it
    expect(byId.get("Merge")?.guarantees.some((g) => g.id === "ok.esm")).toBe(false);

    const unmapped = report.findings.filter((f) => f.rule === "entry-unmapped").map((f) => f.message);
    expect(unmapped.some((m) => m.includes('"./extra"'))).toBe(true);
    expect(unmapped.some((m) => m.includes('"./cjs"'))).toBe(true);
    expect(report.findings.find((f) => f.rule === "entry-unmapped")?.severity).toBe("info");
    // src/extra.ts has guarantees in a package doc, but "./extra" maps to build output only
    const stray = report.findings.filter((f) => f.rule === "guarantee-on-non-unit");
    expect(stray.map((f) => f.file)).toEqual(["src/extra.ts"]);
  });

  test("surface.entries maps a subpath whose targets are build output", async () => {
    const dir = makePackage();
    const config = defineConfig({
      root: dir,
      surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported", entries: { "./extra": "src/extra.ts" } },
      tests: { include: ["tests/**/*.test.ts"] },
    });
    const { report } = await analyze({ ...config, root: dir }, { provenance: false, baseline: null });
    expect(report.units.find((u) => u.id === "entry#extra")?.guarantees.map((g) => g.key)).toEqual([
      "entry#extra.ok.extra",
    ]);
    expect(report.findings.filter((f) => f.rule === "guarantee-on-non-unit")).toEqual([]);
  });

  test("gen writes type and entry skeletons that compile, and fail or skip until filled", async () => {
    const dir = makePackage();
    expect(await main(["gen", "--cwd", dir, "--config", "specgate.config.json"])).toBe(0);
    const types = readFileSync(join(dir, "tests", "index.types.test.ts"), "utf8");
    const entry = readFileSync(join(dir, "tests", "index.entry.test.ts"), "utf8");
    expect(types).toContain('import { checkTypes, todoSnippet } from "@marbull-x-inc/specgate/typecheck";');
    expect(types).toContain('"import type { Merge } from \\"../src/index.ts\\";"');
    expect(types).toContain("expect(errors).toEqual([]);");
    expect(types).toContain("expect(errors.length).toBeGreaterThan(0);");
    expect(entry).toContain('loadEntry(".", { root: process.cwd(), condition: "import" })');
    expect(entry).toContain('loadEntry(".", { root: process.cwd(), condition: "require" })');
    expect(entry).toContain("test.skip(");

    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(dir, "tsconfig.json"),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    );
    if (!parsed) throw new Error("tsconfig did not parse");
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const generated = new Set([join(dir, "tests", "index.types.test.ts"), join(dir, "tests", "index.entry.test.ts")]);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file !== undefined && generated.has(d.file.fileName))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);

    const run = spawnSync("bun", ["test", join(dir, "tests")], { encoding: "utf8", cwd: dir });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toMatch(/ReferenceError|is not defined|Cannot find (module|package)/);
    expect(output).toContain("specgate: write the type expression");
    expect(output).toMatch(/\n 2 fail\n/);
    expect(output).toMatch(/\n 2 skip\n/);
  }, 60_000);
});

describe("helpers", () => {
  test("checkTypes reports errors only for the snippet, with the repository's options", () => {
    const dir = makePackage();
    const ok = checkTypes(
      'import type { Merge } from "./src/index.ts";\nconst m: Merge<{ a: number }, { a: string; b: boolean }> = { a: 1, b: true };\nexport {};',
      { from: dir },
    );
    expect(ok.errors).toEqual([]);
    const bad = checkTypes(
      'import type { Merge } from "./src/index.ts";\nconst m: Merge<{ a: number }, { b: boolean }> = { a: "x", b: true };\nexport {};',
      { from: dir },
    );
    expect(bad.errors.map((e) => [e.code, e.line])).toEqual([[2322, 2]]);
  });

  test("loadEntry imports or requires the package by its own name", () => {
    const dir = makePackage();
    expect(loadEntry(".", { root: dir, condition: "import" })).toEqual({ ok: true, exports: ["merge"] });
    expect(loadEntry("./cjs", { root: dir, condition: "require" })).toEqual({ ok: true, exports: ["legacy"] });
    const notImportable = loadEntry("./cjs", { root: dir, condition: "import" });
    expect(notImportable.ok).toBe(false);
  });
});
