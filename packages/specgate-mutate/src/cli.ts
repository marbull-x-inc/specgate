/**
 * `specgate-mutate`: value mutants (docs/design/0004-value-mutants.md) as one command.
 *
 * specgate lists the value changes and reads the results; it never runs a test. This package
 * is the part that does: it applies each change, runs the project's tests and writes the report.
 *
 *   specgate-mutate [all]   specgate mutants → run → specgate check
 *   specgate-mutate list    specgate mutants (writes .specgate/mutants.json)
 *   specgate-mutate run     apply each listed change and run the tests (writes the value report)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { main as runRunner } from "./runner.ts";

const USAGE = `specgate-mutate [command] [options]

Commands
  all (default)  specgate mutants, then run, then specgate check
  list           specgate mutants: write the value changes to --mutants
  run            apply each change, run the tests, write the value report to --out

Options
  --command <cmd>      Test command (run, all). {files} is replaced by the selected test files,
                       else they are appended. Stop at the first failure (vitest --bail=1, jest --bail).
  --stryker <path>     Stryker report with coveredBy, for test selection
                       (default: reports/mutation/mutation.json when it exists)
  --out <path>         Value report (default: reports/mutation/value.json)
  --mutants <path>     Value-change list (default: .specgate/mutants.json)
  --cwd <dir>          Where the test command runs, relative to the root (a monorepo package)
  --concurrency <n>    Parallel runs in sandboxes (default: logical cores - 1)
  --timeout-ms <n>     Fixed timeout per run (default: as Stryker, from each selection's own time)
  --only <ids>         Comma-separated value-mutant ids (run)
  --config <path>      specgate config (list, all)
  --root <dir>         Project root (default: current directory)
  --specgate <cmd>     How to run specgate (default: the specgate installed in the project)

specgate check reads the value report only when mutation.report lists it, for example
  mutation: { report: ["reports/mutation/mutation.json", "reports/mutation/value.json"] }
`;

const write = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

/** The specgate CLI of the project: its installed bin, else `npx specgate`. */
export function specgateCommand(root: string, override?: string): string[] {
  if (override) return ["sh", "-c", `${override} "$@"`, "specgate"];
  try {
    const require = createRequire(join(root, "package.json"));
    const pkgPath = require.resolve("@marbull-x-inc/specgate/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["specgate"];
    if (bin) return [process.execPath, join(dirname(pkgPath), bin)];
  } catch {
    // not installed in the project
  }
  return ["npx", "--no-install", "specgate"];
}

function spawnInherit(argv: readonly string[], cwd: string): Promise<number> {
  const [cmd, ...args] = argv;
  return new Promise((done) => {
    if (!cmd) return done(2);
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => done(code ?? 1));
    child.on("error", (e) => {
      process.stderr.write(`specgate-mutate: cannot run ${cmd}: ${e.message}\n`);
      done(127);
    });
  });
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      command: { type: "string" },
      stryker: { type: "string" },
      out: { type: "string", default: "reports/mutation/value.json" },
      mutants: { type: "string", default: ".specgate/mutants.json" },
      cwd: { type: "string", default: "." },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string" },
      only: { type: "string" },
      config: { type: "string" },
      root: { type: "string", default: "." },
      specgate: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0] ?? "all";
  if (values.help || !["all", "list", "run"].includes(command)) {
    write(USAGE);
    return values.help ? 0 : 2;
  }
  const root = resolve(values.root);
  const specgate = specgateCommand(root, values.specgate);
  const configArgs = values.config ? ["--config", values.config] : [];

  if (command === "list" || command === "all") {
    const outDir = dirname(values.mutants);
    const code = await spawnInherit([...specgate, "mutants", ...configArgs, "--out", outDir], root);
    if (code !== 0) return code;
    if (command === "list") return 0;
  }

  if (!values.command) {
    process.stderr.write("specgate-mutate: --command is required (the test command to run per change)\n");
    return 2;
  }
  const stryker =
    values.stryker ??
    (existsSync(join(root, "reports/mutation/mutation.json")) ? "reports/mutation/mutation.json" : undefined);
  const concurrency = values.concurrency ?? String(Math.max(1, availableParallelism() - 1));
  const runArgs = [
    "--root",
    root,
    "--mutants",
    values.mutants,
    "--command",
    values.command,
    "--out",
    values.out,
    "--cwd",
    values.cwd,
    "--concurrency",
    concurrency,
    ...(stryker ? ["--stryker", stryker] : []),
    ...(values["timeout-ms"] ? ["--timeout-ms", values["timeout-ms"]] : []),
    ...(values.only ? ["--only", values.only] : []),
  ];
  if (!stryker) process.stderr.write("specgate-mutate: no Stryker report; every change runs the whole test command\n");
  const ran = await runRunner(runArgs);
  if (ran !== 0 || command === "run") return ran;

  write(`specgate-mutate: specgate check (it reads ${values.out} when mutation.report lists it)`);
  return spawnInherit([...specgate, "check", ...configArgs], root);
}
