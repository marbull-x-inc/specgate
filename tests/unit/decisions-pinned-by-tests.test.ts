import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { type ConfigInput, defineConfig } from "../../src/config/schema.ts";
import { extractTests } from "../../src/extract/tests/index.ts";
import type { Decision } from "../../src/ir/schema.ts";
import { quantityUnitUsed, valueUsed } from "../../src/rules/decisions.ts";
import { workDir } from "../helpers/paths.ts";

/** Writes `files` (path → content) under a fresh project with a tsconfig. */
function project(files: Record<string, string>): string {
  const dir = workDir("pinned");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

async function reportOf(dir: string, overrides: ConfigInput = {}) {
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
    ...overrides,
  });
  return (await analyze({ ...config, root: dir }, { provenance: false, baseline: null })).report;
}

const PATHS = Array.from({ length: 26 }, (_, i) => `/denied/path-${String.fromCharCode(97 + i)}`);

const DENY = `
export const DENIED_PATHS: readonly string[] = [
${PATHS.map((p) => `  "${p}",`).join("\n")}
];

export const DENIED_PREFIXES = ["/two-factor/", "/passkey/"] as const;

/**
 * @guarantee ok.listed a \`path\` in \`DENIED_PATHS\` or starting with one of \`DENIED_PREFIXES\` is denied
 */
export function isDenied(path: string): boolean {
  return DENIED_PATHS.includes(path) || DENIED_PREFIXES.some((prefix) => path.startsWith(prefix));
}
`;

function rows(paths: readonly string[]): string {
  return paths.map((p) => `  "${p}",`).join("\n");
}

const DENY_TEST_8_OF_26 = `
import { expect, it } from "bun:test";
import { isDenied } from "../src/deny";

it.each([
${rows(PATHS.slice(0, 8))}
  "/two-factor/enable",
  "/passkey/verify",
])("isDenied.ok.listed %s", (path) => {
  expect(isDenied(path)).toBe(true);
});
`;

describe("member decisions", () => {
  test("each literal element of a collection used for membership is a decision, prefixes probed as prefixes", async () => {
    const report = await reportOf(project({ "src/deny.ts": DENY }));
    const members = (report.units.find((u) => u.id === "isDenied")?.decisions ?? []).filter((d) => d.kind === "member");
    expect(members.filter((d) => d.collection?.name === "DENIED_PATHS")).toHaveLength(26);
    expect(members.filter((d) => d.collection?.name === "DENIED_PATHS").every((d) => d.probe === "exact")).toBe(true);
    expect(members.filter((d) => d.collection?.name === "DENIED_PREFIXES").map((d) => [d.values[0], d.probe])).toEqual([
      ["/two-factor/", "prefix"],
      ["/passkey/", "prefix"],
    ]);
    expect(members[0]?.collection?.file).toBe("src/deny.ts");
  });

  test("Set, Map keys, object keys through `in`, and spreads attributed to the constant they are written in", async () => {
    const source = `
const BASE = ["a1", "a2"] as const;
const ALL = [...BASE, "a3"];
const SET = new Set(["s1", "s2"]);
const MAP = new Map([["m1", 1], ["m2", 2]]);
const OBJ = { o1: true, "o-2": true };

/**
 * @guarantee ok.member membership
 */
export function member(v: string): boolean {
  return ALL.indexOf(v) >= 0 || SET.has(v) || MAP.has(v) || v in OBJ || Object.hasOwn(OBJ, v);
}
`;
    const report = await reportOf(project({ "src/m.ts": source }));
    const members = (report.units.find((u) => u.id === "member")?.decisions ?? []).filter((d) => d.kind === "member");
    const summary = members.map((d) => `${d.collection?.name}:${d.values[0]}:${d.names.join(",")}`);
    expect(summary).toEqual(
      expect.arrayContaining([
        "BASE:a1:ALL,BASE",
        "BASE:a2:ALL,BASE",
        "ALL:a3:ALL",
        "SET:s1:SET",
        "SET:s2:SET",
        "MAP:m1:MAP",
        "MAP:m2:MAP",
        "OBJ:o1:OBJ",
        "OBJ:o-2:OBJ",
      ]),
    );
    expect(summary).toHaveLength(9);
  });

  test("a callback that is not a comparison with the element, or a local array, is not membership", async () => {
    const source = `
const WEIGHTS = [3, 5];

/**
 * @guarantee ok.weighted weighted
 */
export function weighted(v: number): boolean {
  const local = ["x", "y"];
  return WEIGHTS.some((w) => w * 2 > v) || local.includes(String(v));
}
`;
    const report = await reportOf(project({ "src/w.ts": source }));
    const members = (report.units.find((u) => u.id === "weighted")?.decisions ?? []).filter((d) => d.kind === "member");
    expect(members).toEqual([]);
  });

  test("decisions.collectionLimit cuts a collection and says so once", async () => {
    const report = await reportOf(project({ "src/deny.ts": DENY }), { decisions: { collectionLimit: 3 } });
    const members = (report.units.find((u) => u.id === "isDenied")?.decisions ?? []).filter(
      (d) => d.collection?.name === "DENIED_PATHS",
    );
    expect(members).toHaveLength(3);
    const truncated = report.findings.filter((f) => f.rule === "decision-collection-truncated");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]?.message).toContain("DENIED_PATHS holds 26 elements");
    expect(truncated[0]?.severity).toBe("info");
  });
});

describe("decision-untested", () => {
  test("A: a deny list with 8 of 26 elements tested gives 18 findings, and none for prefixes a longer path pins", async () => {
    const report = await reportOf(project({ "src/deny.ts": DENY, "tests/deny.test.ts": DENY_TEST_8_OF_26 }));
    const untested = report.findings.filter((f) => f.rule === "decision-untested");
    expect(untested).toHaveLength(18);
    expect(untested.map((f) => f.message).filter((m) => m.includes('"/denied/path-a"'))).toEqual([]);
    expect(untested.some((m) => m.message.includes('"/denied/path-z"'))).toBe(true);
    expect(untested.some((m) => m.message.includes("DENIED_PREFIXES"))).toBe(false);
    expect(untested[0]?.severity).toBe("warn");
    expect(report.findings.filter((f) => f.rule === "decision-unspecified")).toEqual([]);
  });

  test("A: listing every element clears it", async () => {
    const all = DENY_TEST_8_OF_26.replace(rows(PATHS.slice(0, 8)), rows(PATHS));
    const report = await reportOf(project({ "src/deny.ts": DENY, "tests/deny.test.ts": all }));
    expect(report.findings.filter((f) => f.rule === "decision-untested")).toEqual([]);
  });

  test("A': a prefix no test path starts with is reported", async () => {
    const without = DENY_TEST_8_OF_26.replace('  "/passkey/verify",\n', "");
    const report = await reportOf(project({ "src/deny.ts": DENY, "tests/deny.test.ts": without }));
    const prefixes = report.findings
      .filter((f) => f.rule === "decision-untested")
      .filter((f) => f.message.includes("DENIED_PREFIXES"));
    expect(prefixes.map((f) => f.message)).toEqual([expect.stringContaining('member "/passkey/" (DENIED_PREFIXES)')]);
  });

  test("D: a helper tested only through its caller is pinned by the caller's tests (a boundary by value ± 1)", async () => {
    const source = `
/**
 * @guarantee ok.expired a grant older than \`30\` days is not active
 */
export function isGrantActive(days: number): boolean {
  return days <= 30;
}

/**
 * @guarantee ok.active an active grant is allowed
 */
export function allow(days: number): boolean {
  return isGrantActive(days);
}
`;
    const testFile = `
import { expect, test } from "bun:test";
import { allow } from "../src/grant";

test("allow.ok.active", () => {
  expect(allow(31)).toBe(false);
});
`;
    const report = await reportOf(project({ "src/grant.ts": source, "tests/grant.test.ts": testFile }));
    expect(report.findings.filter((f) => f.rule === "decision-untested")).toEqual([]);
    const untouched = await reportOf(
      project({ "src/grant.ts": source, "tests/grant.test.ts": testFile.replace("allow(31)", "allow(45)") }),
    );
    expect(untouched.findings.filter((f) => f.rule === "decision-untested").map((f) => f.message)).toEqual([
      expect.stringContaining('isGrantActive commits to boundary "30"'),
    ]);
  });

  test("an element reached from two units through a spread is reported once, on the unit in its own module", async () => {
    const shared = `
export const SHARED = ["s1", "s2"];

/**
 * @guarantee ok.listed \`SHARED\` operations need a second factor
 */
export function needsSecondFactor(op: string): boolean {
  return SHARED.includes(op);
}
`;
    const denied = `
import { SHARED } from "./shared";

export const DENIED = [...SHARED, "d1"];

/**
 * @guarantee ok.listed \`DENIED\` operations are denied
 */
export function isDeniedOp(op: string): boolean {
  return DENIED.includes(op);
}
`;
    const testFile = `
import { expect, test } from "bun:test";
import { isDeniedOp } from "../src/denied";
import { needsSecondFactor } from "../src/shared";

test("isDeniedOp.ok.listed", () => {
  expect(isDeniedOp("s1")).toBe(true);
});
test("needsSecondFactor.ok.listed", () => {
  expect(needsSecondFactor("other")).toBe(false);
});
`;
    const report = await reportOf(
      project({ "src/shared.ts": shared, "src/denied.ts": denied, "tests/ops.test.ts": testFile }),
    );
    const untested = report.findings
      .filter((f) => f.rule === "decision-untested")
      .map((f) => `${f.unit}:${f.message.match(/member "([^"]+)"/)?.[1]}:${f.severity}`);
    // s1 is used by a test of isDeniedOp: removing it fails that test, but needsSecondFactor's own
    // tests do not pin it, so it stays reported one step lower (#38).
    expect(untested.sort()).toEqual(["isDeniedOp:d1:warn", "needsSecondFactor:s1:info", "needsSecondFactor:s2:warn"]);
    expect(report.findings.find((f) => f.message.includes('"s1"'))?.message).toContain(
      "(a test of isDeniedOp uses it); needsSecondFactor's own tests cannot fail when it changes",
    );
  });

  test("decisions.ignore silences an element or a whole collection", async () => {
    const dir = project({ "src/deny.ts": DENY, "tests/deny.test.ts": DENY_TEST_8_OF_26 });
    const byValue = await reportOf(dir, { decisions: { ignore: ["/denied/path-z"] } });
    expect(byValue.findings.filter((f) => f.rule === "decision-untested")).toHaveLength(17);
    const byName = await reportOf(dir, { decisions: { ignore: ["DENIED_PATHS"] } });
    expect(byName.findings.filter((f) => f.rule === "decision-untested")).toHaveLength(0);
  });
});

describe("test-tautology", () => {
  test("B: a test that iterates the collection itself is reported, and does not pin its elements", async () => {
    const testFile = `
import { expect, it } from "bun:test";
import { DENIED_PATHS, isDenied } from "../src/deny";

it.each(DENIED_PATHS)("isDenied.ok.listed %s", (path) => {
  expect(isDenied(path)).toBe(true);
});
`;
    const report = await reportOf(project({ "src/deny.ts": DENY, "tests/deny.test.ts": testFile }));
    const tautology = report.findings.filter((f) => f.rule === "test-tautology");
    expect(tautology).toHaveLength(1);
    expect(tautology[0]?.message).toContain("isDenied.ok.listed takes its cases from DENIED_PATHS itself");
    expect(tautology[0]?.file).toBe("tests/deny.test.ts");
    expect(report.findings.filter((f) => f.rule === "decision-untested")).toHaveLength(26 + 2);
  });

  test("a for…of over the collection, or expectations derived with new Set, count in a linked test", async () => {
    const loop = `
import { expect, test } from "bun:test";
import { DENIED_PATHS, isDenied } from "../src/deny";

test("isDenied.ok.listed every listed path", () => {
  for (const path of DENIED_PATHS) expect(isDenied(path)).toBe(true);
});
`;
    const derived = `
import { expect, test } from "bun:test";
import { DENIED_PATHS, isDenied } from "../src/deny";

test("isDenied.ok.listed matches the list", () => {
  const listed = new Set<string>(DENIED_PATHS);
  for (const path of ["/a", "/b"]) expect(isDenied(path)).toBe(listed.has(path));
});
`;
    for (const testFile of [loop, derived]) {
      const report = await reportOf(project({ "src/deny.ts": DENY, "tests/deny.test.ts": testFile }));
      expect(report.findings.filter((f) => f.rule === "test-tautology")).toHaveLength(1);
    }
  });

  test("a test linked to another unit may walk the list to check the list itself", async () => {
    const source = `${DENY}
/**
 * @guarantee ok.absolute every entry of \`DENIED_PATHS\` is an absolute path
 */
export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}
`;
    const testFile = `
import { expect, test } from "bun:test";
import { DENIED_PATHS, isAbsolute } from "../src/deny";

test("isAbsolute.ok.absolute", () => {
  for (const path of DENIED_PATHS) expect(isAbsolute(path)).toBe(true);
});
`;
    const report = await reportOf(project({ "src/deny.ts": source, "tests/deny.test.ts": testFile }));
    expect(report.findings.filter((f) => f.rule === "test-tautology")).toEqual([]);
  });
});

describe("decision-unspecified downgrade", () => {
  const SOURCE = `
/**
 * @guarantee ok.converts converts seconds to milliseconds
 */
export function toMs(seconds: number): number {
  return seconds * 1000;
}
`;

  test("C: a value no linked test writes keeps its severity", async () => {
    const testFile = `
import { expect, test } from "bun:test";
import { toMs } from "../src/ms";

test("toMs.ok.converts", () => {
  expect(toMs(5)).toBe(5000);
});
`;
    const report = await reportOf(project({ "src/ms.ts": SOURCE, "tests/ms.test.ts": testFile }));
    const finding = report.findings.find((f) => f.rule === "decision-unspecified");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message.endsWith("cannot tell whether it is right")).toBe(true);
  });

  test("C: a value a linked test writes is lowered one step and says so", async () => {
    const testFile = `
import { expect, test } from "bun:test";
import { toMs } from "../src/ms";

test("toMs.ok.converts", () => {
  expect(toMs(5)).toBe(5 * 1000);
});
`;
    const dir = project({ "src/ms.ts": SOURCE, "tests/ms.test.ts": testFile });
    const report = await reportOf(dir);
    const finding = report.findings.find((f) => f.rule === "decision-unspecified");
    expect(finding?.severity).toBe("info");
    expect(finding?.message.endsWith("(a linked test uses it)")).toBe(true);
    const blocking = await reportOf(dir, { rules: { "decision-unspecified": "fail" } });
    expect(blocking.findings.find((f) => f.rule === "decision-unspecified")?.severity).toBe("warn");
  });

  test("members the contract never names are reported once per collection", async () => {
    const unnamed = DENY.replace(
      "a `path` in `DENIED_PATHS` or starting with one of `DENIED_PREFIXES` is denied",
      "a listed path is denied",
    );
    const report = await reportOf(project({ "src/deny.ts": unnamed }));
    const messages = report.findings.filter((f) => f.rule === "decision-unspecified").map((f) => f.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(
      'the members of DENIED_PATHS ("/denied/path-a", "/denied/path-b", "/denied/path-c", … (26 in all))',
    );
  });
});

describe("test literals (E)", () => {
  function testsOf(files: Record<string, string>) {
    const dir = project(files);
    const config = defineConfig({ root: dir });
    return extractTests(
      { ...config, root: dir },
      Object.keys(files)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => join(dir, f)),
    ).tests;
  }

  test("body, array-of-arrays and tagged-template tables, describe.each, and a same-file fixture are sources; the title is not", () => {
    const [arrays, tagged, fixture, nested] = testsOf({
      "tests/a.test.ts": `
import { expect, describe, test } from "vitest";
import { shared } from "./fixtures";

const PATHS = ["/from-fixture", 42];

test.each([["/row-a", 86_400_000], ["/row-b", -7]])("op.ok.rows title-word", (p, n) => {
  expect(p).toBe("/body");
});

test.each\`
  path         | code
  \${"/tagged"} | \${404}
\`("op.ok.tagged", ({ path }) => {});

test("op.ok.fixture", () => {
  for (const p of PATHS) expect(p).toBeDefined();
  expect(shared).toBeDefined();
  expect(\`/organization/\${p}/members\`).toBe("x");
});

describe.each([["/describe-row"]])("outer %s", () => {
  test("op.ok.nested", () => {});
});
`,
      "tests/fixtures.ts": `export const shared = ["/elsewhere"];`,
    });
    expect(arrays?.literals).toEqual(expect.arrayContaining(["/row-a", "86400000", "/row-b", "-7", "/body"]));
    expect(arrays?.literals).not.toContain("op.ok.rows title-word");
    expect(tagged?.literals).toEqual(expect.arrayContaining(["/tagged", "404"]));
    expect(tagged?.status).toBe("each");
    expect(fixture?.literals).toEqual(expect.arrayContaining(["/from-fixture", "42", "/organization/", "/members"]));
    // a fixture in another file is not followed (documented limit)
    expect(fixture?.literals).not.toContain("/elsewhere");
    expect(nested?.literals).toContain("/describe-row");
  });

  test("iterates records imported constants with the module they resolve to", () => {
    const [eachTest, loopTest, keysTest] = testsOf({
      "src/lists.ts": `export const LIST = ["a"]; export const MAP = { a: 1 };`,
      "tests/i.test.ts": `
import { test } from "vitest";
import { LIST, MAP as RENAMED } from "../src/lists";
import { ALIASED } from "@app/lists";

test.each(LIST)("op.ok.each %s", () => {});
test("op.ok.loop", () => { for (const x of ALIASED) void x; LIST.forEach(() => {}); });
test("op.ok.keys", () => { for (const k of Object.keys(RENAMED)) void k; });
`,
    });
    expect(eachTest?.iterates).toEqual([{ name: "LIST", from: "src/lists.ts" }]);
    expect(loopTest?.iterates).toEqual([
      { name: "ALIASED", from: "@app/lists" },
      { name: "LIST", from: "src/lists.ts" },
    ]);
    expect(keysTest?.iterates).toEqual([{ name: "MAP", from: "src/lists.ts" }]);
  });

  test("tests.literalLimit caps the literals per test", () => {
    const dir = project({
      "tests/l.test.ts": `import { test } from "vitest";\ntest("op.ok.many", () => { ["a", "b", "c", "d"]; });\n`,
    });
    const config = defineConfig({ root: dir, tests: { literalLimit: 2 } });
    expect(extractTests({ ...config, root: dir }, [join(dir, "tests/l.test.ts")]).tests[0]?.literals).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("valueUsed", () => {
  const d = (kind: Decision["kind"], value: string, probe?: Decision["probe"]): Decision => ({
    kind,
    expression: "",
    line: 1,
    values: [value],
    names: [],
    ...(probe ? { probe } : {}),
  });

  test("numbers by value, boundaries by value ± 1, outputs by containment, members by probe", () => {
    expect(valueUsed(d("constant", "86400000"), ["8.64e7"])).toBe(true);
    expect(valueUsed(d("constant", "30"), ["31"])).toBe(false);
    expect(valueUsed(d("boundary", "30"), ["31"])).toBe(true);
    expect(valueUsed(d("output", "week"), ["1 week ago"])).toBe(true);
    expect(valueUsed(d("match", "week"), ["1 week ago"])).toBe(false);
    // #66: a quantity with the value as its unit pins a match, read from the unit's own tests.
    expect(quantityUnitUsed(d("match", "weeks"), ["2 weeks"])).toBe(true);
    expect(quantityUnitUsed(d("match", "d"), ["2d", "x"])).toBe(true);
    expect(quantityUnitUsed(d("match", "weeks"), ["1 week"])).toBe(false);
    expect(quantityUnitUsed(d("match", "week"), ["1 week ago"])).toBe(false);
    expect(quantityUnitUsed(d("output", "weeks"), ["2 weeks"])).toBe(false);
    expect(valueUsed(d("member", "/admin/", "prefix"), ["/admin/users"])).toBe(true);
    expect(valueUsed(d("member", "/admin/", "exact"), ["/admin/users"])).toBe(false);
    expect(valueUsed(d("member", ".png", "suffix"), ["a.png"])).toBe(true);
    expect(valueUsed(d("member", "bot", "contains"), ["googlebot/2.1"])).toBe(true);
  });
});
