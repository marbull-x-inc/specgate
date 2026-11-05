import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { defineConfig } from "../../src/config/schema.ts";
import type { Report } from "../../src/ir/schema.ts";
import { readRevision } from "../../src/provenance/revision.ts";

/**
 * #42: a default baseline left by a run on another revision may come from another branch. The
 * projects live outside this repository so that its own `.git` is not found.
 */
const A = "a".repeat(40);
const B = "b".repeat(40);

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "specgate-baseline-"));
  write(dir, {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
    ...files,
  });
  return dir;
}

const KEEP = `/** @guarantee ok.kept returns its input */
export function kept(v: string): string {
  return v;
}
`;
const GONE = `/** @guarantee ok.gone returns its input */
export function gone(v: string): string {
  return v;
}
`;

async function run(dir: string, baseline?: Report) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
  });
  return (await analyze({ ...config, root: dir }, { provenance: false, ...(baseline ? { baseline } : {}) })).report;
}

/** A report with `gone`, as if written on revision `revision`, left at the default baseline path. */
async function withStaleBaseline(git: boolean, revision: string | undefined): Promise<{ dir: string; old: Report }> {
  const dir = project({ "src/keep.ts": KEEP, "src/gone.ts": GONE });
  if (git) write(dir, { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": `${A}\n` });
  const old = await run(dir);
  const { revision: _r, ...rest } = old;
  const left: Report = revision ? { ...rest, revision } : rest;
  write(dir, { ".specgate/report.json": JSON.stringify(left), "src/gone.ts": "export {};\n" });
  return { dir, old: left };
}

describe("a baseline from another revision (#42)", () => {
  test("records the revision and the config hash", async () => {
    const { old } = await withStaleBaseline(true, undefined);
    expect(old.configHash).toMatch(/^[0-9a-f]{16}$/);
    const dir = project({ "src/keep.ts": KEEP });
    write(dir, { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": `${A}\n` });
    expect((await run(dir)).revision).toBe(A);
  });

  test("the default baseline from another revision lowers operation-removed and says why", async () => {
    const { dir } = await withStaleBaseline(true, B);
    const report = await run(dir);
    const removed = report.findings.filter((f) => f.rule === "operation-removed");
    expect(removed.map((f) => [f.unit ?? f.message.split(" ")[0], f.severity])).toEqual([["gone", "warn"]]);
    expect(report.findings.filter((f) => f.rule === "baseline-stale").map((f) => [f.severity, f.message])).toEqual([
      [
        "info",
        `the baseline report was written on revision ${B.slice(0, 12)}, this run is on revision ${A.slice(0, 12)}; it may come from another branch, so the change-detection findings are one step lower. Pass --baseline to compare on purpose`,
      ],
    ]);
  });

  test("the same baseline passed explicitly keeps the severity", async () => {
    const { dir, old } = await withStaleBaseline(true, B);
    const report = await run(dir, old);
    expect(report.findings.filter((f) => f.rule === "operation-removed").map((f) => f.severity)).toEqual(["fail"]);
    expect(report.findings.filter((f) => f.rule === "baseline-stale")).toEqual([]);
  });

  test("without .git the output is as before", async () => {
    const { dir } = await withStaleBaseline(false, undefined);
    const report = await run(dir);
    expect(report.revision).toBeUndefined();
    expect(report.findings.filter((f) => f.rule === "operation-removed").map((f) => f.severity)).toEqual(["fail"]);
    expect(report.findings.filter((f) => f.rule === "baseline-stale")).toEqual([]);
  });
});

describe("readRevision", () => {
  test("follows a worktree's .git file, commondir and packed-refs, and a detached HEAD", () => {
    const repo = mkdtempSync(join(tmpdir(), "specgate-rev-"));
    write(repo, {
      "main/.git/packed-refs": `# pack-refs with: peeled\n${B} refs/heads/feature\n`,
      "main/.git/worktrees/wt/HEAD": "ref: refs/heads/feature\n",
      "main/.git/worktrees/wt/commondir": "../..\n",
      "wt/.git": `gitdir: ${join(repo, "main/.git/worktrees/wt")}\n`,
      "detached/.git/HEAD": `${A}\n`,
    });
    mkdirSync(join(repo, "wt/packages/app"), { recursive: true });
    expect(readRevision(join(repo, "wt/packages/app"))).toBe(B);
    expect(readRevision(join(repo, "detached"))).toBe(A);
    expect(readRevision(join(repo, "main/.git/worktrees"))).toBeUndefined();
  });
});
