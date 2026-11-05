#!/usr/bin/env node
// The oracle: makes one small change to an implementation file, runs the project's tests, and
// restores the file. Prints GREEN (tests pass: a hole) or RED (tests fail: pinned).
//
//   node oracle.mjs <project-dir> <cases.json> <out.json> -- <test command…>
//
// cases.json: [{ "id": "…", "file": "src/x.ts", "line": 12, "from": "<=", "to": "<", "occurrence": 1 }]
// `from` is replaced by `to` at its `occurrence`-th match (default 1) on `line`. With
// `"deleteLine": true` the whole line is removed instead (an element of a collection).
// Several edits for one case go in `"edits": [{ file, line, from, to } …]`.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sep = process.argv.indexOf("--");
const [dir, casesPath, outPath] = process.argv.slice(2, sep);
const cmd = process.argv.slice(sep + 1);
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const results = [];

function apply(edit, originals) {
  const path = join(dir, edit.file);
  if (!originals.has(path)) originals.set(path, readFileSync(path, "utf8"));
  const lines = readFileSync(path, "utf8").split("\n");
  const i = edit.line - 1;
  if (edit.deleteLine) {
    lines.splice(i, 1);
  } else {
    let at = -1;
    for (let n = 0; n < (edit.occurrence ?? 1); n++) at = lines[i].indexOf(edit.from, at + 1);
    if (at < 0) throw new Error(`${edit.file}:${edit.line} does not contain ${JSON.stringify(edit.from)}`);
    lines[i] = lines[i].slice(0, at) + edit.to + lines[i].slice(at + edit.from.length);
  }
  writeFileSync(path, lines.join("\n"));
}

for (const c of cases) {
  const originals = new Map();
  let verdict;
  let detail = "";
  try {
    for (const e of c.edits ?? [c]) apply(e, originals);
    // Like Stryker, which inserts `// @ts-nocheck` into every file it mutates, type errors in
    // the changed file do not count as a failing test.
    if (process.env.ORACLE_TYPECHECK !== "1")
      for (const path of originals.keys()) writeFileSync(path, `// @ts-nocheck\n${readFileSync(path, "utf8")}`);
    const r = spawnSync(cmd[0], cmd.slice(1), {
      cwd: dir,
      encoding: "utf8",
      timeout: 600_000,
      env: { ...process.env, CI: "1" },
    });
    verdict = r.status === 0 ? "GREEN" : "RED";
    if (verdict === "RED")
      detail = process.env.ORACLE_DEBUG
        ? (r.stdout + r.stderr).slice(-1500)
        : (r.stdout + r.stderr)
            .split("\n")
            .filter((l) => /✗|×|FAIL|●/.test(l))
            .slice(0, 3)
            .join(" | ");
  } catch (e) {
    verdict = "ERROR";
    detail = String(e.message);
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
  results.push({ id: c.id, verdict, detail: detail.slice(0, 400) });
  process.stdout.write(`${`${c.id}\t${verdict}\t${detail.slice(0, 160)}`}\n`);
}
writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
