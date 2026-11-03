import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Test-time helpers for guarantees that no test runner checks by itself.
 *
 * @remarks
 * bun, ts-jest with `isolatedModules` and vitest outside `--typecheck` run tests without type
 * checking, so a `// @ts-expect-error` inside a test proves nothing. `checkTypes` runs the
 * TypeScript checker from inside the test instead, which every runner executes. `loadEntry`
 * imports or requires the built package by its own name in a child Node process, the way a
 * consumer would. Kept apart from `@marbull-x-inc/specgate/runtime` so that tests which never
 * use them do not load TypeScript.
 */
export interface TypeDiagnostic {
  code: number;
  message: string;
  /** 1-based line in `source` */
  line: number;
}

function pathOf(from: string): string {
  return from.startsWith("file:") ? fileURLToPath(from) : resolve(from);
}

function findTsconfig(dir: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(current) === current) return undefined;
  }
}

function compilerOptionsFor(tsconfig: string | undefined): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  };
  if (!tsconfig) return fallback;
  const read = ts.readConfigFile(tsconfig, (f) => ts.sys.readFile(f));
  if (read.error) return fallback;
  // Only options matter; file discovery is skipped (the snippet is the only root).
  const parsed = ts.parseJsonConfigFileContent(read.config, { ...ts.sys, readDirectory: () => [] }, dirname(tsconfig));
  return parsed.options;
}

/**
 * Type-checks `source` as if it were a module next to `from`.
 *
 * @param source - Module text. Imports resolve from `from`'s directory, with the repository's
 *   compiler options (paths, module resolution, `strict`).
 * @param options - `from`: `import.meta.url`, `__filename` or a path of the calling test.
 *   `tsconfig`: the config to take options from; by default the nearest `tsconfig.json` above
 *   `from`.
 * @returns The syntactic and semantic diagnostics of the snippet only; errors elsewhere in the
 *   program are not included.
 */
export function checkTypes(source: string, options: { from: string; tsconfig?: string }): { errors: TypeDiagnostic[] } {
  const fromPath = pathOf(options.from);
  const dir = existsSync(fromPath) && statSync(fromPath).isDirectory() ? fromPath : dirname(fromPath);
  const tsconfig = options.tsconfig ? resolve(options.tsconfig) : findTsconfig(dir);
  const compilerOptions = { ...compilerOptionsFor(tsconfig), noEmit: true };
  const snippet = join(dir, `__specgate_check_${process.pid}.ts`);
  const host = ts.createCompilerHost(compilerOptions);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (f) => (resolve(f) === snippet ? source : readFile(f));
  host.fileExists = (f) => resolve(f) === snippet || fileExists(f);
  host.getSourceFile = (f, languageVersion, onError, shouldCreate) =>
    resolve(f) === snippet
      ? ts.createSourceFile(f, source, languageVersion, true)
      : getSourceFile(f, languageVersion, onError, shouldCreate);
  const program = ts.createProgram({ rootNames: [snippet], options: compilerOptions, host });
  const sf = program.getSourceFile(snippet);
  if (!sf) return { errors: [{ code: 0, message: "specgate: the snippet could not be loaded", line: 1 }] };
  const diagnostics = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  return {
    errors: diagnostics.map((d) => ({
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      line: d.start === undefined ? 1 : sf.getLineAndCharacterOfPosition(d.start).line + 1,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads an entry of the package under test by its own name, in a child Node process started in
 * `root`, the way a consumer would (it needs the package built, since `exports` usually point to
 * build output).
 *
 * @param subpath - `package.json#exports` subpath: `"."`, `"./runtime"`.
 * @param options - `root`: the package directory. `condition`: `"import"` (ESM `import()`) or
 *   `"require"` (CommonJS `require`).
 * @returns The export names on success, or the error message. Only names cross the process
 *   boundary.
 */
export function loadEntry(
  subpath: string,
  options: { root: string; condition: "import" | "require"; node?: string },
): { ok: true; exports: string[] } | { ok: false; error: string } {
  const root = resolve(options.root);
  let name: unknown;
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    name = isRecord(pkg) ? pkg["name"] : undefined;
  } catch (error) {
    return { ok: false, error: `cannot read ${join(root, "package.json")}: ${String(error)}` };
  }
  if (typeof name !== "string") return { ok: false, error: "package.json has no name" };
  const specifier = subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`;
  const lit = JSON.stringify(specifier);
  const script =
    options.condition === "import"
      ? `import(${lit}).then((m) => { process.stdout.write(JSON.stringify(Object.keys(m).sort())); }, (e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); });`
      : `try { const m = require(${lit}); process.stdout.write(JSON.stringify(Object.keys(m).sort())); } catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(1); }`;
  const args = options.condition === "import" ? ["--input-type=module", "-e", script] : ["-e", script];
  const run = spawnSync(options.node ?? "node", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) return { ok: false, error: (run.stderr || run.error?.message || "failed").trim() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { ok: false, error: `unexpected output from the child process: ${run.stdout.slice(0, 200)}` };
  }
  return Array.isArray(parsed) && parsed.every((n: unknown) => typeof n === "string")
    ? { ok: true, exports: parsed }
    : { ok: false, error: "unexpected output from the child process" };
}

/**
 * Placeholder for the type expression of a generated type test: always throws, so the test fails
 * with the statement it still has to express until the author replaces it with source text.
 *
 * @throws Error always, naming the statement.
 */
export function todoSnippet(statement: string): never {
  throw new Error(`specgate: write the type expression for "${statement}"`);
}
