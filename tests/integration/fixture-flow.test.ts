import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zReport } from "../../scripts/ir-schema.zod.ts";
import { main } from "../../src/cli.ts";
import { EXAMPLE_SHOP, workDir } from "../helpers/paths.ts";

/**
 * The whole workflow on a repository that shares nothing with any particular company:
 * flat `src/`, jest, English prose. If a repo-specific assumption leaks into the core, this
 * is where it shows.
 */
const repo = join(workDir("flow"), "shop");

function git(args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

function run(...args: string[]): Promise<number> {
  return main([...args, "--cwd", repo]);
}

function read(rel: string): string {
  return readFileSync(join(repo, rel), "utf8");
}

beforeAll(() => {
  cpSync(EXAMPLE_SHOP, repo, { recursive: true });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "fixture: initial guarantees (#41)"]);
});

describe("init → scaffold → gen → check → docs", () => {
  test("init writes tsdoc.json and the CI workflow, keeps the existing config", async () => {
    expect(await run("init", "--ci", "--adapter", "jest")).toBe(0);
    expect(JSON.parse(read("tsdoc.json")).extends).toEqual(["specgate/tsdoc.json"]);
    expect(read(".github/workflows/specgate.yml")).toContain("specgate check");
    expect(read("specgate.config.ts")).toContain('adapter: "jest"'); // untouched fixture config
  });

  test("scaffold documents the undocumented use case from its signature and body", async () => {
    expect(await run("scaffold")).toBe(0);
    const source = read("src/application/cancel-order.ts");
    expect(source).toContain("@param orderId - TODO (string)");
    expect(source).toContain("@throws {@link OrderNotFoundError} TODO");
    expect(source).toContain("@uses TransactionRunner, OrderRepository");
    expect(source).toContain("@guarantee TODO");
    // ports without guarantees get tags appended inside their existing comment
    expect(read("src/ports/clock.ts")).toMatch(/@port\n \* @guarantee TODO/);
    // documented units are left alone
    expect(read("src/application/place-order.ts")).not.toContain("TODO");
  });

  test("gen creates mirror tests, appends missing guarantees, and regenerates doctest/property files", async () => {
    expect(await run("gen")).toBe(0);
    const period = read("tests/domain/period.test.ts");
    expect(period).toContain('import { isWithinPeriod } from "../../src/domain/period";');
    expect(period).toContain("const clock = fakeClock();");
    expect(period).toContain('test.todo("isWithinPeriod.ok.within ');
    const appended = read("tests/domain/money.test.ts");
    expect(appended).toContain('test.todo("addMoney.ok.pure a and b are unchanged after the call");');
    expect(appended.indexOf("addMoney.ok.sum adds")).toBeLessThan(appended.indexOf("(specgate)"));
    const doctest = read("tests/domain/money.doctest.test.ts");
    expect(doctest).toContain(
      'expect(addMoney({ amount: 1, currency: "JPY" }, { amount: 2, currency: "JPY" })).toEqual({ amount: 3, currency: "JPY" });',
    );
    const property = read("tests/domain/money.property.test.ts");
    expect(property).toContain("fc.assert(fc.property(arb, (v) => acceptsAgain(zMoney, v))");
    expect(property).toContain('test.todo("zMoney.invariant-1 amount is a non-negative integer");');
    expect(existsSync(join(repo, "tests/ports/order-repository.test.ts"))).toBe(true);
  });

  test("gen is idempotent: a second run changes nothing in hand-edited files", async () => {
    const before = read("tests/domain/money.test.ts");
    expect(await run("gen")).toBe(0);
    expect(read("tests/domain/money.test.ts")).toBe(before);
  });

  test("gen for a class without a test file arranges stubs, a fault runner and a fake clock", async () => {
    const dir = workDir("gen-class");
    cpSync(EXAMPLE_SHOP, dir, { recursive: true });
    expect(await main(["gen", "--unit", "PlaceOrderUseCase", "--cwd", dir, "--dry-run"])).toBe(0);
    // The fixture ships a test file for placeOrder, so remove it from the copy to see the full skeleton.
    spawnSync("rm", [join(dir, "tests/application/place-order.test.ts")]);
    expect(await main(["gen", "--unit", "PlaceOrderUseCase", "--cwd", dir])).toBe(0);
    const generated = readFileSync(join(dir, "tests/application/place-order.test.ts"), "utf8");
    expect(generated).toContain('const tx = createFaultRunner<TransactionRunner>(["run"]);');
    expect(generated).toContain('const orders = createStub<OrderRepository>(["findById", "save", "listByAccount"]);');
    expect(generated).toContain("const clock = fakeClock();");
    expect(generated).toContain("const sut = new PlaceOrderUseCase(tx, orders, notifications, clock);");
    expect(generated).toContain("rejects.toThrow(EmptyOrderError)");
    expect(generated).toContain('import { EmptyOrderError } from "../../src/errors";');
    expect(generated).toContain("faultRunnerControl(tx).failurePoints()");
    expect(generated).toMatch(
      /import \{ describe, expect, test \} from "@jest\/globals";\nimport \{ createFaultRunner/,
    );
  });

  test("check writes IR, Step Summary and SARIF; advisory exits 0, --strict exits 1 while placeholders remain", async () => {
    expect(await run("check")).toBe(0);
    const report = zReport.parse(JSON.parse(read(".specgate/report.json")));
    expect(report.summary.units).toBe(8);
    expect(report.summary.unitsWithoutGuarantee).toBe(0); // scaffold placed placeholders everywhere
    expect(report.summary.orphanTests).toBe(1);
    expect(report.summary.unlinkedTests).toBe(1);
    const rules = new Set(report.findings.map((f) => f.rule));
    expect(rules).toEqual(new Set(["guarantee-placeholder", "test-orphan", "test-todo", "env-input-direct"]));
    // the placeholder @modifies TODO must not be treated as a declared port
    expect(report.findings.some((f) => f.rule === "uses-mismatch")).toBe(false);
    // identifiers in the documented operations all resolve
    for (const u of report.units)
      for (const g of u.guarantees) expect(g.references.filter((r) => r.kind === "unresolved")).toEqual([]);
    // provenance from git: introduced by the fixture commit, PR parsed from the subject
    const placeOrder = report.units.find((u) => u.id === "PlaceOrderUseCase#placeOrder");
    expect(placeOrder?.guarantees.find((g) => g.id === "ok.stored")?.provenance?.introduced?.pr).toBe("41");
    expect(placeOrder?.operationCalls).toEqual(["addMoney"]);
    expect(placeOrder?.portCalls.map((c) => c.member).sort()).toEqual(["now", "orderPlaced", "run", "save"]);
    // the "how" of the undocumented use case: env input found
    const cancel = report.units.find((u) => u.id === "CancelOrderUseCase#cancelOrder");
    expect(cancel?.envInputs.map((e) => e.expression)).toEqual(["new Date"]);
    expect(read(".specgate/summary.md")).toContain("| Units | Without guarantee |");
    const sarif = JSON.parse(read(".specgate/report.sarif"));
    expect(sarif.runs[0].results.length).toBe(report.findings.length);
    expect(await run("check", "--strict")).toBe(1);
  });

  test("check detects a changed guarantee whose test did not change, using the previous report as baseline", async () => {
    const file = join(repo, "src/domain/money.ts");
    const edited = readFileSync(file, "utf8").replace(
      "@guarantee ok.sum result.amount = a.amount + b.amount",
      "@guarantee ok.sum result.amount = a.amount + b.amount (never overflows)",
    );
    await Bun.write(file, edited);
    expect(await run("check")).toBe(0);
    const report = zReport.parse(JSON.parse(read(".specgate/report.json")));
    expect(report.findings.map((f) => f.rule)).toContain("guarantee-changed-test-unchanged");
  });

  test("docs renders what / why / how per unit plus index and vocabulary", async () => {
    expect(await run("docs")).toBe(0);
    const page = read("docs/spec/src/application/place-order.md");
    expect(page).toContain("## PlaceOrderUseCase#placeOrder");
    expect(page).toContain("### Why");
    expect(page).toContain("| `ok.stored` | ok |");
    expect(page).toContain("| `OrderRepository` | `save` | 1 | modifies |");
    expect(page).toContain("Calls public operations: [`addMoney`]");
    expect(read("docs/spec/index.md")).toContain("`PlaceOrderUseCase#placeOrder`");
    const vocab = read("docs/spec/vocabulary.md");
    expect(vocab).toContain("### zMoney");
    expect(vocab).toContain("- start <= end");
    expect(vocab).toContain("### OrderRepository");
  });
});
