#!/usr/bin/env node
/**
 * Value-mutant runner (docs/design/0004-value-mutants.md). Not part of the published package:
 * specgate never runs tests, this script does.
 *
 * Applies each change of `specgate mutants` (`.specgate/mutants.json`) one at a time, with
 * `// @ts-nocheck` prepended to the changed file as Stryker does, runs the test command,
 * restores the file and writes a mutation-testing-report-schema v2 report (`mutatorName:
 * "Value"`) that `mutation.report` reads next to Stryker's.
 *
 * Usage (Node 24 runs the TypeScript directly; `bun` works too):
 *
 *   node scripts/value-mutants/run.ts --command "npx vitest run {files}" \
 *     [--mutants .specgate/mutants.json] [--stryker reports/mutation/mutation.json] \
 *     [--out reports/mutation/value.json] [--root .] [--concurrency 1] [--timeout-ms <n>]
 *
 * With `--stryker`, only the test files that cover the site (from `coveredBy` of the innermost
 * Stryker mutant whose location contains it) are run: they replace `{files}` in the command, or
 * are appended to it. Otherwise the whole command runs.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export interface ValueMutant {
  id: string;
  unit: string;
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  start: number;
  end: number;
  kind: string;
  original: string;
  replacement: string;
  description: string;
}

export interface ValueMutantList {
  schemaVersion: string;
  files: Record<string, { sha256: string }>;
  mutants: ValueMutant[];
}

export type Status = "Killed" | "Survived" | "Timeout" | "NoCoverage" | "Ignored";

export interface RunResult {
  mutant: ValueMutant;
  status: Status;
  statusReason?: string;
  coveredBy?: string[];
  durationMs: number;
}

/** Which tests to run for a site: all of them, none (no test reaches it), or these test files. */
export type Selection = { all: true } | { none: true } | { files: string[]; tests: string[] };

interface StrykerMutant {
  file: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  coveredBy?: string[];
  static: boolean;
}

export interface StrykerCoverage {
  mutants: Map<string, StrykerMutant[]>;
  /** Test id → test file, relative to root */
  testFile: Map<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Reads `coveredBy` and `testFiles` from a Stryker (mutation-testing-report-schema) report. */
export function readStrykerCoverage(path: string, root: string): StrykerCoverage {
  const report: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(report) || !isRecord(report["files"])) throw new Error(`${path} is not a mutation report`);
  const base = typeof report["projectRoot"] === "string" ? resolve(root, report["projectRoot"]) : root;
  const rel = (p: string): string => toPosix(relative(root, isAbsolute(p) ? p : resolve(base, p)));
  const mutants = new Map<string, StrykerMutant[]>();
  for (const [file, entry] of Object.entries(report["files"])) {
    if (!isRecord(entry) || !Array.isArray(entry["mutants"])) continue;
    const list: StrykerMutant[] = [];
    for (const m of entry["mutants"]) {
      if (!isRecord(m) || !isRecord(m["location"])) continue;
      const loc = m["location"];
      const s = loc["start"];
      const e = loc["end"];
      if (!isRecord(s) || !isRecord(e)) continue;
      const coveredBy = Array.isArray(m["coveredBy"]) ? m["coveredBy"].map(String) : undefined;
      list.push({
        file: rel(file),
        start: { line: Number(s["line"]), column: Number(s["column"]) },
        end: { line: Number(e["line"]), column: Number(e["column"]) },
        ...(coveredBy ? { coveredBy } : {}),
        static: m["static"] === true,
      });
    }
    mutants.set(rel(file), list);
  }
  const testFile = new Map<string, string>();
  if (isRecord(report["testFiles"]))
    for (const [file, entry] of Object.entries(report["testFiles"])) {
      if (!isRecord(entry) || !Array.isArray(entry["tests"])) continue;
      for (const t of entry["tests"])
        if (isRecord(t) && t["id"] !== undefined) testFile.set(String(t["id"]), rel(file));
    }
  return { mutants, testFile };
}

function before(a: { line: number; column: number }, b: { line: number; column: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.column <= b.column);
}

/**
 * The tests that can reach a site: those covering the innermost Stryker mutant whose location
 * contains it. A test that reaches the site entered that mutant's code, so this is a superset.
 */
export function selectTests(m: ValueMutant, coverage: StrykerCoverage | undefined): Selection {
  if (!coverage) return { all: true };
  const start = { line: m.line, column: m.column };
  const end = { line: m.endLine, column: m.endColumn };
  const containing = (coverage.mutants.get(m.file) ?? [])
    .filter((s) => before(s.start, start) && before(end, s.end))
    .sort((a, b) => a.end.line - a.start.line - (b.end.line - b.start.line) || a.end.column - b.end.column);
  const inner = containing[0];
  if (!inner || inner.static || inner.coveredBy === undefined) return { all: true };
  if (inner.coveredBy.length === 0) return { none: true };
  const files = new Set<string>();
  for (const id of inner.coveredBy) {
    const f = coverage.testFile.get(id);
    if (f === undefined) return { all: true };
    files.add(f);
  }
  return { files: [...files].sort(), tests: inner.coveredBy };
}

/** The command with `{files}` replaced (or the files appended). An empty list runs everything. */
export function commandFor(command: string, files: readonly string[]): string {
  const quoted = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
  if (command.includes("{files}")) return command.replace("{files}", quoted);
  return quoted ? `${command} ${quoted}` : command;
}

/** The file's text with the change applied and `// @ts-nocheck` prepended (after a shebang). */
export function mutatedText(text: string, m: ValueMutant): string {
  const changed = text.slice(0, m.start) + m.replacement + text.slice(m.end);
  if (changed.startsWith("#!")) {
    const nl = changed.indexOf("\n");
    return `${changed.slice(0, nl + 1)}// @ts-nocheck\n${changed.slice(nl + 1)}`;
  }
  return `// @ts-nocheck\n${changed}`;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      done({ code: 127, timedOut });
    });
  });
}

/** Copies the project for a worker; `node_modules` directories are symlinked, `.git` is skipped. */
function makeSandbox(root: string, target: string): void {
  mkdirSync(target, { recursive: true });
  const walk = (from: string, to: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".stryker-tmp") continue;
      const src = join(from, entry.name);
      const dst = join(to, entry.name);
      if (entry.name === "node_modules" && entry.isDirectory()) symlinkSync(src, dst, "dir");
      else if (entry.isDirectory()) {
        mkdirSync(dst);
        walk(src, dst);
      } else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
      else cpSync(src, dst);
    }
  };
  walk(root, target);
}

export interface RunOptions {
  root: string;
  command: string;
  coverage?: StrykerCoverage;
  concurrency?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Runs every mutant of the list.
 * @returns One result per mutant, in list order, and the duration of the first, unmutated run.
 */
export async function runValueMutants(
  list: ValueMutantList,
  options: RunOptions,
): Promise<{ results: RunResult[]; baselineMs: number }> {
  const root = resolve(options.root);
  const log = options.log ?? (() => {});
  const texts = new Map<string, string>();
  const stale = new Map<string, string>();
  for (const [file, { sha256 }] of Object.entries(list.files)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      stale.set(file, "file not found");
      continue;
    }
    const text = stripBom(readFileSync(path, "utf8"));
    if (createHash("sha256").update(text).digest("hex") !== sha256)
      stale.set(file, "the file changed after `specgate mutants`");
    texts.set(file, text);
  }

  const t0 = Date.now();
  const baseline = await runCommand(options.command, root, 30 * 60_000);
  const baselineMs = Date.now() - t0;
  if (baseline.code !== 0) throw new Error(`the test command fails before any change (exit ${baseline.code})`);
  const timeoutMs = options.timeoutMs ?? Math.max(30_000, baselineMs * 5);
  log(`baseline run ${baselineMs} ms; timeout ${timeoutMs} ms`);

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const sandboxBase = concurrency > 1 ? mkdtempSync(join(tmpdir(), "value-mutants-")) : undefined;
  const workers = Array.from({ length: concurrency }, (_, i) => {
    if (!sandboxBase) return root;
    const dir = join(sandboxBase, `sandbox-${i}`);
    makeSandbox(root, dir);
    return dir;
  });

  // Restore every file a worker changed, also on an interrupt.
  const dirty = new Map<string, string>();
  const restoreAll = (): void => {
    for (const [path, text] of dirty) writeFileSync(path, text);
    dirty.clear();
  };
  const onSignal = (): void => {
    restoreAll();
    if (sandboxBase) rmSync(sandboxBase, { recursive: true, force: true });
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: RunResult[] = new Array(list.mutants.length);
  let next = 0;
  // Runs of the whole command go one at a time: a test runner already spreads one run over every
  // core, so several at once only make each slower (and past the timeout). Runs of selected test
  // files stay parallel.
  let wholeRun: Promise<void> = Promise.resolve();
  const exclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = wholeRun;
    let release = (): void => {};
    wholeRun = new Promise((r) => {
      release = r;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
  const work = async (dir: string): Promise<void> => {
    for (;;) {
      const index = next++;
      const m = list.mutants[index];
      if (!m) return;
      const startedAt = Date.now();
      const result = await runOne(m, dir);
      results[index] = { ...result, mutant: m, durationMs: Date.now() - startedAt };
      log(`${m.id} ${result.status.padEnd(10)} ${m.file}:${m.line} ${m.description}`);
    }
  };
  const runOne = async (
    m: ValueMutant,
    dir: string,
    alone = false,
  ): Promise<Omit<RunResult, "mutant" | "durationMs">> => {
    const reason = stale.get(m.file);
    if (reason) return { status: "Ignored", statusReason: reason };
    const text = texts.get(m.file);
    if (text === undefined) return { status: "Ignored", statusReason: "file not listed" };
    if (text.slice(m.start, m.end) !== m.original)
      return { status: "Ignored", statusReason: "the original text is not at the listed offsets" };
    const selection = selectTests(m, options.coverage);
    if ("none" in selection) return { status: "NoCoverage", statusReason: "no test covers the site", coveredBy: [] };
    const files = "files" in selection ? selection.files : [];
    const path = join(dir, m.file);
    const original = readFileSync(path, "utf8");
    dirty.set(path, original);
    try {
      writeFileSync(path, mutatedText(text, m));
      const run = (): Promise<{ code: number | null; timedOut: boolean }> =>
        runCommand(commandFor(options.command, files), dir, timeoutMs);
      const { code, timedOut } = alone || files.length > 0 ? await run() : await exclusive(run);
      const coveredBy = "files" in selection ? { coveredBy: selection.tests } : {};
      if (timedOut)
        return { status: "Timeout", ...(alone ? { statusReason: "timed out on its own" } : {}), ...coveredBy };
      return code === 0
        ? { status: "Survived", ...coveredBy }
        : { status: "Killed", statusReason: `exit ${code}`, ...coveredBy };
    } finally {
      writeFileSync(path, original);
      dirty.delete(path);
    }
  };

  try {
    await Promise.all(workers.map(work));
    // A run that timed out while other runs shared the machine is run again on its own: only a
    // second timeout, with no other run competing for the cores, is reported as Timeout.
    if (concurrency > 1)
      for (const [index, r] of results.entries()) {
        if (r?.status !== "Timeout") continue;
        const startedAt = Date.now();
        const again = await runOne(r.mutant, workers[0] ?? root, true);
        results[index] = { ...again, mutant: r.mutant, durationMs: Date.now() - startedAt };
        log(`${r.mutant.id} ${again.status.padEnd(10)} (rerun alone) ${r.mutant.file}:${r.mutant.line}`);
      }
  } finally {
    restoreAll();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (sandboxBase) rmSync(sandboxBase, { recursive: true, force: true });
  }
  return { results, baselineMs };
}

/** A mutation-testing-report-schema v2 report of the results. */
export function toReport(results: readonly RunResult[], root: string): Record<string, unknown> {
  const files: Record<string, { language: string; source: string; mutants: unknown[] }> = {};
  for (const r of results) {
    const m = r.mutant;
    let entry = files[m.file];
    if (!entry) {
      entry = {
        language: /\.[cm]?tsx?$/.test(m.file) ? "typescript" : "javascript",
        source: existsSync(join(root, m.file)) ? readFileSync(join(root, m.file), "utf8") : "",
        mutants: [],
      };
      files[m.file] = entry;
    }
    entry.mutants.push({
      id: m.id,
      mutatorName: "Value",
      // The description, so a finding and an `@acceptFinding mutant-survived Value:"…"` quote it.
      replacement: m.description,
      description: m.description,
      location: { start: { line: m.line, column: m.column }, end: { line: m.endLine, column: m.endColumn } },
      status: r.status,
      ...(r.statusReason !== undefined ? { statusReason: r.statusReason } : {}),
      ...(r.coveredBy !== undefined ? { coveredBy: r.coveredBy } : {}),
      duration: r.durationMs,
    });
  }
  return { schemaVersion: "2", thresholds: { high: 80, low: 60 }, projectRoot: root, files };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      mutants: { type: "string", default: ".specgate/mutants.json" },
      command: { type: "string" },
      stryker: { type: "string" },
      out: { type: "string", default: "reports/mutation/value.json" },
      root: { type: "string", default: "." },
      concurrency: { type: "string", default: "1" },
      "timeout-ms": { type: "string" },
      only: { type: "string" },
    },
  });
  if (!values.command) {
    process.stderr.write("value-mutants: --command is required\n");
    return 2;
  }
  const root = resolve(values.root);
  const list = JSON.parse(readFileSync(resolve(root, values.mutants), "utf8")) as ValueMutantList;
  if (values.only) {
    const only = new Set(values.only.split(","));
    list.mutants = list.mutants.filter((m) => only.has(m.id));
  }
  const coverage = values.stryker ? readStrykerCoverage(resolve(root, values.stryker), root) : undefined;
  const t0 = Date.now();
  const { results, baselineMs } = await runValueMutants(list, {
    root,
    command: values.command,
    ...(coverage ? { coverage } : {}),
    concurrency: Number(values.concurrency),
    ...(values["timeout-ms"] ? { timeoutMs: Number(values["timeout-ms"]) } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const out = resolve(root, values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(toReport(results, root), null, 2)}\n`);
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  process.stdout.write(
    `value-mutants: ${results.length} mutant(s): ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")}; ` +
      `${Date.now() - t0} ms (baseline run ${baselineMs} ms)\nwrote ${out}\n`,
  );
  return 0;
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  process.exitCode = await main(process.argv.slice(2));
}
