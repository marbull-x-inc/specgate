import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main, specgateCommand } from "../../packages/specgate-mutate/src/cli.ts";
import { PACKAGE_ROOT, workDir } from "../helpers/paths.ts";

const VALUES = `export const ARTICLES = ["a", "an", "the", "of"];

/** @guarantee ok.known a known word */
export function isKnown(word: string): boolean {
  return ARTICLES.includes(word);
}
`;

const TEST = `import { expect, test } from "bun:test";
import { isKnown } from "../src/values";

test("isKnown.ok.known", () => {
  expect(isKnown("a")).toBe(true);
});
`;

function project(): string {
  const dir = workDir("specgate-mutate");
  const files: Record<string, string> = {
    "src/values.ts": VALUES,
    "tests/values.test.ts": TEST,
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
    "specgate.config.json": JSON.stringify({
      surface: { include: ["src/**/*.ts"], mode: "exported" },
      tests: { include: ["tests/**/*.test.ts"] },
      provenance: { enabled: false },
      mutation: { report: ["reports/mutation/value.json"] },
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** specgate from this repository's source, so the test needs no build. */
const SPECGATE = `'${process.execPath}' '${join(PACKAGE_ROOT, "src", "cli.ts")}'`;

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const out = spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await run();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("specgate-mutate", () => {
  test("all lists the changes, runs them and lets specgate check report the survivors", async () => {
    const dir = project();
    const code = await quietly(() =>
      main([
        "all",
        "--root",
        dir,
        "--specgate",
        SPECGATE,
        "--command",
        `'${process.execPath}' test`,
        "--concurrency",
        "1",
      ]),
    );
    expect(code).toBe(0);
    expect(existsSync(join(dir, ".specgate/mutants.json"))).toBe(true);
    const value = JSON.parse(readFileSync(join(dir, "reports/mutation/value.json"), "utf8")) as {
      files: Record<string, { mutants: Array<{ status: string; description: string }> }>;
    };
    expect(value.files["src/values.ts"]?.mutants.map((m) => m.status)).toEqual([
      "Killed",
      "Survived",
      "Survived",
      "Survived",
    ]);
    const report = JSON.parse(readFileSync(join(dir, ".specgate/report.json"), "utf8")) as {
      findings: Array<{ rule: string; unit?: string; message: string }>;
    };
    const survived = report.findings.filter((f) => f.rule === "mutant-survived");
    expect(survived.map((f) => f.message)).toContain(
      'isKnown: `"an"` removed from `ARTICLES` survived; no linked test fails when the code changes like this',
    );
    expect(survived).toHaveLength(3);
  }, 60_000);

  test("list writes only the change list; run needs a test command", async () => {
    const dir = project();
    expect(await quietly(() => main(["list", "--root", dir, "--specgate", SPECGATE]))).toBe(0);
    expect(existsSync(join(dir, ".specgate/mutants.json"))).toBe(true);
    expect(existsSync(join(dir, "reports/mutation/value.json"))).toBe(false);
    expect(await quietly(() => main(["run", "--root", dir]))).toBe(2);
    expect(await quietly(() => main(["unknown"]))).toBe(2);
  });

  test("specgate is taken from the project, else from npx", () => {
    expect(specgateCommand(mkdtempSync(join(tmpdir(), "specgate-mutate-")))).toEqual([
      "npx",
      "--no-install",
      "specgate",
    ]);
    expect(specgateCommand("/", "bun x specgate")).toEqual(["sh", "-c", 'bun x specgate "$@"', "specgate"]);
  });
});
