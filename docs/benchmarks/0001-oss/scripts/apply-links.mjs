#!/usr/bin/env node
// Links existing tests to guarantees by renaming titles only.
//
//   node apply-links.mjs <project-root> <links.json>
//
// links.json: [{ "file": "test/x.test.ts", "line": 12, "title": "original title", "key": "fn.ok.id", "reason": "…" }]
// `line` is the 1-based line of the `it(` / `test(` call. The first string literal after the
// call's "(" (on that line or the next ones) must start with `title`; `key ` is inserted at its
// start. Nothing else in the file changes. Exits 1 if any entry does not match.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, spec] = process.argv.slice(2);
if (!root || !spec) {
  process.stderr.write(`${"usage: apply-links.mjs <project-root> <links.json>"}\n`);
  process.exit(2);
}
const links = JSON.parse(readFileSync(spec, "utf8"));
const byFile = new Map();
for (const l of links) if (l.key) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);

let failed = 0;
for (const [file, list] of byFile) {
  const path = join(root, file);
  let text = readFileSync(path, "utf8");
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const edits = [];
  for (const l of list) {
    const from = lineStarts[l.line - 1];
    if (from === undefined) {
      process.stderr.write(`${`${file}:${l.line} no such line`}\n`);
      failed++;
      continue;
    }
    // The first `(` + optional whitespace + quote whose literal starts with the title, within the
    // next 3000 characters (covers `it.each(table)("title", …)` and titles on the next line).
    const window = text.slice(from, from + 3000);
    const esc = l.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\(\\s*(["'\`])${esc}`).exec(window);
    if (!m) {
      process.stderr.write(`${`${file}:${l.line} title not found: ${JSON.stringify(l.title)}`}\n`);
      failed++;
      continue;
    }
    const quoteAt = from + m.index + m[0].length - l.title.length - 1;
    edits.push({ at: quoteAt + 1, insert: `${l.key} ` });
  }
  edits.sort((a, b) => b.at - a.at);
  for (const e of edits) text = text.slice(0, e.at) + e.insert + text.slice(e.at);
  writeFileSync(path, text);
  process.stdout.write(`${`${file}: ${edits.length} title(s) linked`}\n`);
}
process.exit(failed ? 1 : 0);
