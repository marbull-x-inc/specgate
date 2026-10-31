import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze, exitCodeFor } from "./analyze.ts";
import { initRepo } from "./commands/init.ts";
import { scaffoldDocs } from "./commands/scaffold.ts";
import { loadConfig } from "./config/load.ts";
import { renderDocs, writeDocs } from "./docs/index.ts";
import { generateTests } from "./gen/index.ts";
import { renderConsole, writeReportFiles } from "./report/index.ts";

const USAGE = `specgate <command> [options]

Commands
  init       Write tsdoc.json and specgate.config.ts (and a CI workflow with --ci)
  scaffold   Add TSDoc skeletons to public operations without guarantees
  gen        Generate / append tests from guarantees
  check      Judge guarantees ↔ tests ↔ implementation; write IR JSON, Step Summary, SARIF
  docs       Render code-derived Markdown from the IR

Options
  --cwd <dir>        Repository root (default: current directory)
  --config <path>    Config file (default: specgate.config.{ts,js,json} in cwd)
  --unit <id>        scaffold / gen: only this unit (Target#operation or Target)
  --dry-run          scaffold / gen: print instead of writing
  --strict           check: exit 1 on fail findings even in advisory mode
  --no-provenance    check: skip git blame / log
  --baseline <path>  check: previous report.json for change detection (default: .specgate/report.json)
  --out <dir>        check: output directory (default: .specgate); docs: docs directory
  --ci               init: also write .github/workflows/specgate.yml
  --force            init: overwrite existing files
  --adapter <name>   init: bun | vitest | jest | playwright
  --no-preset        init: do not extend preset-ddd-ts
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      config: { type: "string" },
      unit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      "no-provenance": { type: "boolean", default: false },
      baseline: { type: "string" },
      out: { type: "string" },
      ci: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      adapter: { type: "string" },
      "no-preset": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const cwd = resolve(values.cwd ?? process.cwd());

  if (command === "init") {
    const adapter = values.adapter;
    const result = initRepo(cwd, {
      ci: values.ci,
      force: values.force,
      preset: values["no-preset"] ? "none" : "ddd-ts",
      ...(adapter === "bun" || adapter === "vitest" || adapter === "jest" || adapter === "playwright"
        ? { adapter }
        : {}),
    });
    for (const f of result.written) console.log(`wrote   ${f}`);
    for (const f of result.skipped) console.log(`skipped ${f} (exists; use --force)`);
    return 0;
  }

  const { config, path } = await loadConfig(cwd, values.config);
  if (!path) console.error("specgate: no config file found, using defaults (run `specgate init`)");

  if (command === "check") {
    const baselineOption = values.baseline ? await readBaseline(resolve(cwd, values.baseline)) : undefined;
    const { report } = await analyze(config, {
      provenance: !values["no-provenance"],
      ...(baselineOption !== undefined ? { baseline: baselineOption } : {}),
    });
    const outDir = resolve(config.root, values.out ?? config.output.dir);
    const files = writeReportFiles(report, outDir);
    console.log(renderConsole(report));
    console.log(`\nwrote ${files.json}\n      ${files.summary}\n      ${files.sarif}`);
    return exitCodeFor(report, values.strict);
  }

  if (command === "scaffold") {
    const { extracted } = await analyze(config, { provenance: false, baseline: null });
    const result = scaffoldDocs(config, extracted, {
      dryRun: values["dry-run"],
      ...(values.unit ? { unitFilter: values.unit } : {}),
    });
    if (result.edits.length === 0) console.log("scaffold: every public operation already has guarantee tags");
    for (const e of result.edits) {
      console.log(`${values["dry-run"] ? "would " : ""}${e.kind} ${e.unit} (${e.file})`);
      if (values["dry-run"]) console.log(e.text);
    }
    return 0;
  }

  if (command === "gen") {
    const { extracted, report } = await analyze(config, { provenance: false, baseline: null });
    const result = generateTests(config, extracted, report.vocabulary.entities, {
      dryRun: values["dry-run"],
      ...(values.unit ? { unitFilter: values.unit } : {}),
    });
    for (const w of result.written) {
      console.log(`${values["dry-run"] ? "would " : ""}${w.action.padEnd(11)} ${w.path}`);
      if (values["dry-run"] && w.action !== "unchanged") console.log(w.content);
    }
    return 0;
  }

  if (command === "docs") {
    const { report } = await analyze(config, { provenance: true, baseline: null });
    const outDir = resolve(config.root, values.out ?? config.output.docsDir);
    const paths = writeDocs(renderDocs(report), outDir);
    for (const p of paths) console.log(`wrote ${p}`);
    return 0;
  }

  console.error(`specgate: unknown command "${command}"\n`);
  console.log(USAGE);
  return 1;
}

async function readBaseline(path: string) {
  const { readFileSync } = await import("node:fs");
  const { isReport } = await import("./ir/schema.ts");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isReport(parsed)) throw new Error(`${path} is not a specgate report`);
  return parsed;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
