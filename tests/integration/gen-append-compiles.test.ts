import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { main } from "../../src/cli.ts";
import { PACKAGE_ROOT, workDir } from "../helpers/paths.ts";

/**
 * An append to an existing test file must compile under a strict test tsconfig and load under
 * the runner. The shapes are those that broke in a first adoption: the file imports the unit
 * as a type only, a dependency is a class with private constructor fields and its own
 * `transactionRunner`, relative imports need `.ts`, and parameters are typed.
 */
const FILES: Record<string, string> = {
  "src/ports.ts": `export interface TransactionRunner {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
export interface OrderRepository {
  save(code: string): Promise<void>;
}
export class NotFoundError extends Error {}
`,
  "src/redeem.service.ts": `import type { OrderRepository, TransactionRunner } from "./ports.ts";
export class RedeemService {
  constructor(
    private readonly transactionRunner: TransactionRunner,
    private readonly orders: OrderRepository,
  ) {}
  async execute(code: string): Promise<void> {
    await this.transactionRunner.run(() => this.orders.save(code));
  }
}
`,
  "src/complete.ts": `import { NotFoundError, type OrderRepository, type TransactionRunner } from "./ports.ts";
import type { RedeemService } from "./redeem.service.ts";
export class CompleteUseCase {
  constructor(
    private readonly transactionRunner: TransactionRunner,
    private readonly redeem: RedeemService,
    private readonly orders: OrderRepository,
  ) {}
  /**
   * Completes an action.
   * @throws {@link NotFoundError} err.missing \`code\` is empty
   * @guarantee ok.saved OrderRepository holds \`code\` afterwards
   * @guarantee atomic when any port fails, OrderRepository is unchanged
   * @uses TransactionRunner
   * @uses RedeemService
   * @modifies OrderRepository
   */
  async complete(accountId: string, input: { code: string }): Promise<number> {
    if (input.code === "") throw new NotFoundError(accountId);
    await this.transactionRunner.run(async () => {
      await this.redeem.execute(input.code);
      await this.orders.save(input.code);
    });
    return 1;
  }
}
`,
  "tests/complete.test.ts": `import { describe, expect, test } from "bun:test";
import type { CompleteUseCase } from "../src/complete.ts";

describe("CompleteUseCase", () => {
  test("CompleteUseCase#complete.ok.saved saves", () => {
    const unused: CompleteUseCase | undefined = undefined;
    expect(unused).toBeUndefined();
  });
});
`,
};

describe("gen appends skeletons that compile and load", () => {
  test("type-only import, class dependency, .ts imports, typed parameters", async () => {
    const repo = workDir("append-compiles");
    for (const [name, content] of Object.entries(FILES)) {
      mkdirSync(join(repo, name, ".."), { recursive: true });
      writeFileSync(join(repo, name), content);
    }
    writeFileSync(
      join(repo, "specgate.config.json"),
      JSON.stringify({
        surface: { include: ["src/complete.ts"], exclude: [], mode: "exported" },
        tests: { include: ["tests/**/*.test.ts"], adapter: "bun", importExtension: ".ts", lineWidth: 100 },
      }),
    );
    writeFileSync(
      join(repo, "tsconfig.json"),
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
          paths: { "@marbull-x-inc/specgate/runtime": [join(PACKAGE_ROOT, "src", "runtime", "index.ts")] },
        },
        include: ["src/**/*.ts", "tests/**/*.ts"],
      }),
    );
    expect(await main(["gen", "--cwd", repo, "--config", "specgate.config.json"])).toBe(0);
    const file = join(repo, "tests", "complete.test.ts");
    const content = readFileSync(file, "utf8");

    // the type-only binding became a value import, without a duplicate
    expect(content).toContain('import { CompleteUseCase } from "../src/complete.ts";');
    expect(content).not.toContain("import type { CompleteUseCase }");
    // the dependency's private fields are not stub members; the unit's own runner gets the faults
    expect(content).toContain('createStub<RedeemService>(["execute"])');
    expect(content).toContain("const transactionRunner = createFaultRunner<TransactionRunner>");
    expect(content).toContain('from "../src/redeem.service.ts"');
    expect(content).not.toContain("undefined, ");
    for (const line of content.split("\n"))
      if (!/^\s*(test|test\.skip)\(/.test(line)) expect(line.length).toBeLessThanOrEqual(100);

    // strict typecheck of the test file
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(repo, "tsconfig.json"),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    );
    if (!parsed) throw new Error("tsconfig did not parse");
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === file)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);

    // it loads and runs: the hand-written test passes, the throws skeleton fails on the placeholder
    const run = spawnSync("bun", ["test", file], { encoding: "utf8", cwd: repo });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toMatch(/ReferenceError|is not defined|SyntaxError/);
    expect(output).toContain("fill in the arguments (accountId, input)");
    expect(output).toMatch(/\n 1 pass\n/);
    expect(output).toMatch(/\n 1 skip\n/);
  }, 60_000);
});

describe("text from doc comments cannot become code", () => {
  test("a multi-line statement stays inside the generated comment and string", async () => {
    const repo = workDir("gen-injection");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "f.ts"),
      `export class BadError extends Error {}
/**
 * @throws {@link BadError} err.bad first line
 * globalThis.injected = true; second line   third
 */
export function f(x: number): number {
  if (x < 0) throw new BadError("bad");
  return x;
}
`,
    );
    writeFileSync(
      join(repo, "specgate.config.json"),
      JSON.stringify({
        surface: { include: ["src/f.ts"], exclude: [], mode: "exported" },
        tests: { include: ["tests/**/*.test.ts"], adapter: "bun", importExtension: ".ts" },
      }),
    );
    expect(await main(["gen", "--cwd", repo, "--config", "specgate.config.json"])).toBe(0);
    const content = readFileSync(join(repo, "tests", "f.test.ts"), "utf8");
    // every line holding the statement is a comment or inside the title literal
    for (const line of content.split("\n"))
      if (line.includes("globalThis.injected"))
        expect(line.trim().startsWith("//") || line.includes('test("')).toBe(true);
    expect(content).not.toContain(" ");
    const sf = ts.createSourceFile("f.test.ts", content, ts.ScriptTarget.Latest, true);
    const assignments: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        assignments.push(n.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(assignments).toEqual([]);
  });
});
