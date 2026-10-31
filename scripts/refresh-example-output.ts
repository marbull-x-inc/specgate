/**
 * Regenerates examples/shop-expected from examples/shop by running
 * scaffold → gen → check → docs on a scratch copy. The integration test
 * tests/integration/example-output.test.ts fails when the committed output drifts.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyze.ts";
import { scaffoldDocs } from "../src/commands/scaffold.ts";
import { loadConfig } from "../src/config/load.ts";
import { renderDocs, writeDocs } from "../src/docs/index.ts";
import { generateTests } from "../src/gen/index.ts";
import { writeReportFiles } from "../src/report/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLE = join(root, "examples", "shop");
export const EXPECTED = join(root, "examples", "shop-expected");
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

/** Runs the flow on a copy and returns the files that make up the expected output. */
export async function produceExampleOutput(): Promise<Map<string, string>> {
  const workBase = join(root, "tests", "fixtures", ".work");
  mkdirSync(workBase, { recursive: true });
  const work = mkdtempSync(join(workBase, "example-"));
  const repo = join(work, "shop");
  cpSync(EXAMPLE, repo, { recursive: true });
  const { config } = await loadConfig(repo);
  const first = await analyze(config, { provenance: false, baseline: null });
  scaffoldDocs(config, first.extracted);
  const second = await analyze(config, { provenance: false, baseline: null });
  generateTests(config, second.extracted, second.report.vocabulary.entities, { now: FIXED_NOW });
  const third = await analyze(config, { provenance: false, baseline: null });
  writeReportFiles(third.report, join(repo, ".specgate"));
  writeDocs(renderDocs(third.report), join(repo, "docs", "spec"));

  const out = new Map<string, string>();
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) collect(path);
      else out.set(relative(repo, path), normalise(readFileSync(path, "utf8")));
    }
  };
  collect(join(repo, "src"));
  collect(join(repo, "tests"));
  collect(join(repo, "docs", "spec"));
  out.set(".specgate/summary.md", normalise(readFileSync(join(repo, ".specgate", "summary.md"), "utf8")));
  rmSync(work, { recursive: true, force: true });
  return out;
}

/** Drops the one non-deterministic line (docs index timestamp). */
function normalise(text: string): string {
  return text.replace(/^_Generated .*$/m, "_Generated (timestamp omitted)._");
}

if (import.meta.main) {
  const files = await produceExampleOutput();
  rmSync(EXPECTED, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const path = join(EXPECTED, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${files.size} files to examples/shop-expected\n`);
}
