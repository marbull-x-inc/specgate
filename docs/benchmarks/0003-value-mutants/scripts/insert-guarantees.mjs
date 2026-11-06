#!/usr/bin/env node
// Inserts blind guarantees into a project's sources without the author editing them by hand.
//
//   node insert-guarantees.mjs <project-root> <guarantees.json>
//
// guarantees.json: [{ "file": "src/x.ts", "symbol": "name", "tags": ["@guarantee ok.a …", …] }]
// The block goes above the first line that declares `symbol` (`export function name`,
// `export const name`, `export class name`, `name(` inside a class for "Class#method").
// When a `/** … */` comment ends on the line just above, the tags are merged into it.
// Prints only the file and line it changed, never the source.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, spec] = process.argv.slice(2);
if (!root || !spec) {
  process.stderr.write(`${"usage: insert-guarantees.mjs <project-root> <guarantees.json>"}\n`);
  process.exit(2);
}
const entries = JSON.parse(readFileSync(spec, "utf8"));
const byFile = new Map();
for (const e of entries) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const [file, list] of byFile) {
  const path = join(root, file);
  const lines = readFileSync(path, "utf8").split("\n");
  // Resolve every target line first, then insert bottom-up so line numbers stay valid.
  const targets = list.map((e) => {
    let re;
    if (e.symbol.includes("#")) {
      const [cls, method] = e.symbol.split("#");
      const clsLine = lines.findIndex((l) => new RegExp(`\\bclass\\s+${esc(cls)}\\b`).test(l));
      if (clsLine < 0) throw new Error(`${file}: class ${cls} not found`);
      re = new RegExp(`^\\s*(?:public\\s+|static\\s+|async\\s+|get\\s+)*${esc(method)}\\s*[(<]`);
      const idx = lines.findIndex((l, i) => i > clsLine && re.test(l));
      if (idx < 0) throw new Error(`${file}: ${e.symbol} not found`);
      return { e, idx };
    }
    re = new RegExp(
      `^\\s*export\\s+(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${esc(e.symbol)}\\b`,
    );
    let idx = lines.findIndex((l) => re.test(l));
    // `const name = …; export default name` (default-exported declarations)
    if (idx < 0)
      idx = lines.findIndex((l) =>
        new RegExp(`^(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${esc(e.symbol)}\\b`).test(l),
      );
    if (idx < 0) throw new Error(`${file}: ${e.symbol} not found`);
    return { e, idx };
  });
  targets.sort((a, b) => b.idx - a.idx);
  for (const { e, idx } of targets) {
    const indent = lines[idx].match(/^\s*/)[0];
    const tagLines = e.tags.map((t) => `${indent} * ${t}`);
    // Existing doc comment directly above (allowing decorators / blank-free adjacency)?
    const end = idx - 1;
    if (end >= 0 && /\*\/\s*$/.test(lines[end])) {
      let start = end;
      while (start >= 0 && !/^\s*\/\*\*/.test(lines[start])) start--;
      if (start >= 0) {
        if (/^\s*\/\*\*.*\*\/\s*$/.test(lines[end]) && start === end) {
          // one-line doc: /** text */
          const text = lines[end].replace(/^\s*\/\*\*\s?/, "").replace(/\s*\*\/\s*$/, "");
          lines.splice(end, 1, `${indent}/**`, `${indent} * ${text}`, ...tagLines, `${indent} */`);
        } else {
          lines.splice(end, 0, ...tagLines);
        }
        process.stdout.write(`${`${file}:${idx + 1} ${e.symbol} merged ${e.tags.length} tag(s)`}\n`);
        continue;
      }
    }
    lines.splice(
      idx,
      0,
      `${indent}/**`,
      ...(e.summary ? [`${indent} * ${e.summary}`] : []),
      ...tagLines,
      `${indent} */`,
    );
    process.stdout.write(`${`${file}:${idx + 1} ${e.symbol} inserted ${e.tags.length} tag(s)`}\n`);
  }
  writeFileSync(path, lines.join("\n"));
}
