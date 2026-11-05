import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyze } from "../../src/analyze.ts";
import { defineConfig } from "../../src/config/schema.ts";
import type { Decision } from "../../src/ir/schema.ts";
import { renderStepSummary, toSarif } from "../../src/report/index.ts";
import { untestedMessage, valueUsed } from "../../src/rules/decisions.ts";
import { workDir } from "../helpers/paths.ts";

/**
 * #39: a test pins a value without writing it as a whole literal — as a `key=value` pair, as an
 * object key — and a string that only configures a library call is not output.
 */
function project(files: Record<string, string>): string {
  const dir = workDir("forms");
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

async function untested(files: Record<string, string>) {
  const dir = project(files);
  const config = defineConfig({
    root: dir,
    surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
    tests: { include: ["tests/**/*.test.ts"] },
  });
  const { report } = await analyze({ ...config, root: dir }, { provenance: false, baseline: null });
  return { report, untested: report.findings.filter((f) => f.rule === "decision-untested") };
}

const POPUP = `const FLAG = "popup";

/**
 * Whether the page was opened in a popup.
 *
 * @guarantee ok.flag returns true only when the \`popup\` query parameter is \`1\`
 */
export const isPopup = (search: string): boolean => new URLSearchParams(search).get(FLAG) === "1";
`;

const CLAIMS = `/**
 * @guarantee err.issuer returns \`bad_issuer\` when \`iss\` is not the expected issuer
 * @guarantee err.audience returns \`bad_audience\` when \`aud\` is not the expected audience
 */
export const reasonOf = (e: { claim: string }): "bad_issuer" | "bad_audience" | "other" => {
  if (e.claim === "iss") return "bad_issuer";
  if (e.claim === "aud") return "bad_audience";
  return "other";
};

/** @guarantee ok.reason returns the reason for the first claim that is wrong */
export function verify(claims: Record<string, string>): string {
  const claim = Object.keys(claims)[0] ?? "";
  return reasonOf({ claim });
}
`;

describe("decision-untested reads the forms a test pins a value in (#39)", () => {
  test("a key=value pair pins a match on a value read with that key", async () => {
    const { report, untested: found } = await untested({
      "src/popup.ts": POPUP,
      "tests/popup.test.ts": `import { expect, it } from "bun:test";
import { isPopup } from "../src/popup";
it("isPopup.ok.flag", () => {
  expect(isPopup("?popup=1")).toBe(true);
  expect(isPopup("?popup=0")).toBe(false);
});
`,
    });
    expect(report.units.find((u) => u.id === "isPopup")?.decisions.find((d) => d.kind === "match")?.key).toBe("popup");
    expect(found).toEqual([]);
  });

  test("without the key, the same digit elsewhere does not count, and the closest literal is named", async () => {
    const { untested: found } = await untested({
      "src/popup.ts": POPUP,
      "tests/popup.test.ts": `import { expect, it } from "bun:test";
import { isPopup } from "../src/popup";
it("isPopup.ok.flag", () => {
  expect(isPopup("?other=1")).toBe(false);
});
`,
    });
    expect(found.map((f) => f.message)).toEqual([
      'isPopup commits to match "1" and the contract names it, but no linked test uses it (closest: "?other=1"); a test cannot fail when it changes',
    ]);
  });

  test("an object key pins an identifier-like match, reached through a caller's test", async () => {
    const { untested: found } = await untested({
      "src/claims.ts": CLAIMS,
      "tests/claims.test.ts": `import { expect, it } from "bun:test";
import { verify } from "../src/claims";
const sign = (claims: { iss?: string; aud?: string } = {}) => ({ iss: "me", aud: "app", ...claims });
it("verify.ok.reason", () => {
  expect(verify(sign({ iss: "https://evil.example" }))).toBe("bad_issuer");
  expect(verify({ aud: "other" })).toBe("bad_audience");
});
`,
    });
    expect(found).toEqual([]);
  });

  test("an object key pins only an identifier-like match value, and a key=value pair only with its key", () => {
    const match = (value: string, key?: string): Decision => ({
      kind: "match",
      expression: "",
      line: 1,
      values: [value],
      names: [],
      ...(key ? { key } : {}),
    });
    expect(valueUsed(match("iss"), [], ["iss"])).toBe(true);
    expect(valueUsed(match("/home"), [], ["/home"])).toBe(false);
    expect(valueUsed({ ...match("iss"), kind: "output" }, [], ["iss"])).toBe(false);
    expect(valueUsed(match("1", "popup"), ["/p?a=2&popup=1#top"])).toBe(true);
    expect(valueUsed(match("1", "popup"), ["?popup=10"])).toBe(false);
    expect(valueUsed(match("1", "popup"), ["?xpopup=1"])).toBe(false);
    expect(valueUsed(match("1"), ["?popup=1"])).toBe(false);
  });

  test("a string passed as an option to a library call is not output; one returned or passed to project code is", async () => {
    const { report, untested: found } = await untested({
      "node_modules/schemalib/package.json": JSON.stringify({ name: "schemalib", types: "index.d.ts" }),
      "node_modules/schemalib/index.d.ts":
        "export declare function toJSONSchema(s: unknown, o: { io: string }): object;\n",
      "src/schemas.ts": `import { toJSONSchema } from "schemalib";
import { describeSchema } from "./local";

/** @guarantee ok.lenient schemas for inputs are written with \`io\` = \`input\`, so they allow unknown keys */
export const toSchemas = () => ({ request: toJSONSchema({}, { io: "input" }) });

/** @guarantee ok.named the schema is described with \`mode\` = \`strict\` */
export const described = () => describeSchema({ mode: "strict" });
`,
      "src/local.ts": "export const describeSchema = (o: { mode: string }): string => o.mode;\n",
      "tests/schemas.test.ts": `import { expect, it } from "bun:test";
import { described, toSchemas } from "../src/schemas";
it("toSchemas.ok.lenient", () => {
  expect(toSchemas().request).not.toHaveProperty("additionalProperties", false);
});
it("described.ok.named", () => {
  expect(typeof described()).toBe("string");
});
`,
    });
    const outputs = (id: string) =>
      report.units
        .find((u) => u.id === id)
        ?.decisions.filter((d) => d.kind === "output")
        .flatMap((d) => d.values);
    expect(outputs("toSchemas")).toEqual([]);
    expect(outputs("described")).toEqual(["strict"]);
    expect(found.map((f) => [f.unit, f.message.split(" and ")[0]])).toEqual([
      ["described", 'described commits to output "strict"'],
    ]);
  });
});

describe("decision-untested on an element another unit's tests pin (#38)", () => {
  const ALPHA = `export const ALPHA = ["x", "y"];

/** @guarantee ok.in a \`v\` in \`ALPHA\` is in */
export function isAlpha(v: string): boolean {
  return ALPHA.includes(v);
}
`;
  const BETA = `import { ALPHA } from "./alpha";

export const BETA = [...ALPHA, "z"];

/** @guarantee ok.in a \`v\` in \`BETA\` is in */
export function isBeta(v: string): boolean {
  return BETA.includes(v);
}
`;
  const OTHER = `/** @guarantee ok.echo returns \`v\` */
export function echo(v: string): string {
  return v;
}
`;

  test("is one step lower and names that unit; an unrelated test does not count", async () => {
    const { untested: found } = await untested({
      "src/alpha.ts": ALPHA,
      "src/beta.ts": BETA,
      "src/other.ts": OTHER,
      "tests/alpha.test.ts": `import { expect, it } from "bun:test";
import { isAlpha } from "../src/alpha";
it("isAlpha.ok.in", () => {
  expect(isAlpha("nope")).toBe(false);
});
`,
      "tests/beta.test.ts": `import { expect, it } from "bun:test";
import { isBeta } from "../src/beta";
it("isBeta.ok.in", () => {
  expect(isBeta("x")).toBe(true);
  expect(isBeta("z")).toBe(true);
});
`,
      "tests/other.test.ts": `import { expect, it } from "bun:test";
import { echo } from "../src/other";
it("echo.ok.echo", () => {
  expect(echo("y")).toBe("y");
});
`,
    });
    expect(found.map((f) => [f.unit, f.severity, f.message.match(/member "([^"]+)"/)?.[1]]).sort()).toEqual([
      ["isAlpha", "info", "x"],
      ["isAlpha", "warn", "y"],
    ]);
    expect(found.find((f) => f.severity === "info")?.message).toBe(
      'isAlpha commits to member "x" (ALPHA) and the contract names it, but no linked test uses it (a test of isBeta uses it); isAlpha\'s own tests cannot fail when it changes',
    );
  });
});

describe("@acceptFinding (#40)", () => {
  const RANGE = (tags: string) => `/**
 * @guarantee ok.adult an \`age\` of 18 or more is adult
${tags} */
export function isAdult(age: number): boolean {
  return age >= 18;
}
`;
  const TEST = `import { expect, it } from "bun:test";
import { isAdult } from "../src/adult";
it("isAdult.ok.adult", () => {
  expect(isAdult(30)).toBe(true);
});
`;
  const run = async (tags: string) => {
    const dir = project({ "src/adult.ts": RANGE(tags), "tests/adult.test.ts": TEST });
    const config = defineConfig({
      root: dir,
      surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
      tests: { include: ["tests/**/*.test.ts"] },
    });
    return (await analyze({ ...config, root: dir }, { provenance: false, baseline: null })).report;
  };

  test("a matching tag makes the finding info, accepted, with its reason in the report and in SARIF", async () => {
    const report = await run(
      ' * @acceptFinding decision-untested "18" the caller clamps ages to 21+, so 18 cannot reach this\n',
    );
    const f = report.findings.find((x) => x.rule === "decision-untested");
    expect([f?.severity, f?.accepted, f?.acceptedReason]).toEqual([
      "info",
      true,
      "the caller clamps ages to 21+, so 18 cannot reach this",
    ]);
    expect(report.units[0]?.accepts?.map((a) => [a.rule, a.target])).toEqual([["decision-untested", '"18"']]);
    const result = (
      toSarif(report) as { runs: Array<{ results: Array<Record<string, unknown>> }> }
    ).runs[0]?.results.find((r) => r["ruleId"] === "decision-untested");
    expect(result?.["suppressions"]).toEqual([
      { kind: "inSource", justification: "the caller clamps ages to 21+, so 18 cannot reach this" },
    ]);
    expect(report.findings.filter((x) => x.rule.startsWith("accept-tag"))).toEqual([]);
  });

  test("a tag without a reason or with an unknown rule is accept-tag-invalid, and accepts nothing", async () => {
    const report = await run(' * @acceptFinding decision-untested "18"\n * @acceptFinding no-such-rule x because\n');
    expect(report.findings.filter((x) => x.rule === "accept-tag-invalid").map((x) => [x.severity, x.message])).toEqual([
      ["fail", "@acceptFinding on isAdult gives no reason; write @acceptFinding <rule-id> <value> <reason>"],
      [
        "fail",
        '@acceptFinding on isAdult names no rule specgate has ("no-such-rule"); write @acceptFinding <rule-id> <value> <reason>',
      ],
    ]);
    expect(report.findings.find((x) => x.rule === "decision-untested")?.severity).toBe("warn");
  });

  test("a tag no finding matches any more is accept-tag-unused", async () => {
    const report = await run(' * @acceptFinding decision-untested "21" an old boundary\n');
    expect(report.findings.filter((x) => x.rule === "accept-tag-unused").map((x) => [x.severity, x.message])).toEqual([
      ["warn", '@acceptFinding decision-untested "21" on isAdult matches no finding any more; remove it'],
    ]);
  });
});

describe("0.5.1: keys passed with a collection, the closest hint, built inputs (#45, #46, #47)", () => {
  const VIEW = `import { readEnum } from "./read-enum";

export const VIEWS = ["list", "grid"] as const;

/** @guarantee ok.view opens the view that \`?view=\` names (\`VIEWS\`) */
export function viewOf(search: string): string {
  const view = readEnum(search, "view", VIEWS, "list");
  return VIEWS.find((value) => value === view) ?? "list";
}
`;
  const READ_ENUM = `export function readEnum(search: string, key: string, values: readonly string[], fallback: string): string {
  const v = new URLSearchParams(search).get(key) ?? "";
  return values.includes(v) ? v : fallback;
}
`;
  const viewTest = (...searches: string[]) => `import { expect, it } from "bun:test";
import { viewOf } from "../src/view";
it("viewOf.ok.view", () => {
${searches.map((s) => `  expect(viewOf("${s}")).not.toBeNull();`).join("\n")}
});
`;

  test("#45: a member read with the key passed alongside the collection is pinned by key=value", async () => {
    const { report, untested: found } = await untested({
      "src/view.ts": VIEW,
      "src/read-enum.ts": READ_ENUM,
      "tests/view.test.ts": viewTest("?view=grid", "?a=1&view=list#top"),
    });
    expect(
      report.units
        .find((u) => u.id === "viewOf")
        ?.decisions.filter((d) => d.kind === "member")
        .map((d) => d.key),
    ).toEqual(["view", "view"]);
    expect(found).toEqual([]);
  });

  test("#45: another key does not pin it, and the hint is the literal with a whole token", async () => {
    const { untested: found } = await untested({
      "src/view.ts": VIEW,
      "src/read-enum.ts": READ_ENUM,
      "tests/view.test.ts": viewTest("mode=grid"),
    });
    expect(found.map((f) => f.message.match(/member "([^"]+)"/)?.[1]).sort()).toEqual(["grid", "list"]);
    expect(found.find((f) => f.message.includes('"grid"'))?.message).toContain('(closest: "mode=grid")');
  });

  test("#45: a collection passed to a call without a string is unchanged", async () => {
    const { report } = await untested({
      "src/view.ts": VIEW.replace('readEnum(search, "view", VIEWS, "list")', "readEnum(search, search, VIEWS, search)"),
      "src/read-enum.ts": READ_ENUM,
      "tests/view.test.ts": viewTest("?view=grid"),
    });
    expect(
      report.units
        .find((u) => u.id === "viewOf")
        ?.decisions.filter((d) => d.kind === "member")
        .map((d) => d.key),
    ).toEqual([undefined, undefined]);
  });

  test("#46: the hint prefers a key= pair, then a whole token, and skips a mere substring for short values", () => {
    const d = (value: string, key?: string): Decision => ({
      kind: "match",
      expression: "",
      line: 1,
      values: [value],
      names: [],
      ...(key ? { key } : {}),
    });
    const unit = { id: "u" } as never;
    const message = (decision: Decision, literals: string[]) =>
      untestedMessage(unit, decision, literals).match(/\(closest: "([^"]*)"\)/)?.[1];
    expect(message(d("1", "popup"), ["javascript:alert(1)", "https://app.example.com/done?popup=0"])).toBe(
      "https://app.example.com/done?popup=0",
    );
    expect(message({ ...d("settings"), kind: "member" }, ["settings-panel", "tab=settings"])).toBe("tab=settings");
    expect(message(d("1"), ["v1.2"])).toBeUndefined();
    expect(message(d("week"), ["weekly"])).toBe("weekly");
  });

  const TARGET = `export const toTargetHref = (origin: string, inPopup: boolean): string =>
  inPopup ? \`\${origin}/done?popup=1\` : \`\${origin}/done\`;

/** @guarantee ok.only accepts \`<origin>/done\` with no query or \`?popup=1\` */
export const parseTarget = (raw: string): string | null => {
  const url = new URL(raw);
  if (url.searchParams.has("popup") && url.searchParams.get("popup") !== "1") return null;
  return raw;
};
`;

  test("#47: a test that builds its input with a function of the unit's module is named", async () => {
    const { untested: found } = await untested({
      "src/target.ts": TARGET,
      "tests/target.test.ts": `import { expect, it } from "bun:test";
import { parseTarget, toTargetHref } from "../src/target";
const APP = "https://app.example.com";
it.each([toTargetHref(APP, true), toTargetHref(APP, false)])("parseTarget.ok.only %s", (href) => {
  expect(parseTarget(href)).toBe(href);
});
`,
    });
    expect(found.map((f) => f.message)).toEqual([
      'parseTarget commits to match "1" and the contract names it, but no linked test writes it; parseTarget.ok.only builds its input with toTargetHref from the unit\'s own module, so the value changes with the implementation. Write it as a literal',
    ]);
  });

  test("#47: writing the value as a literal clears it; a helper from a test-support file does not change the message", async () => {
    const cleared = await untested({
      "src/target.ts": TARGET,
      "tests/target.test.ts": `import { expect, it } from "bun:test";
import { parseTarget, toTargetHref } from "../src/target";
const APP = "https://app.example.com";
it.each([toTargetHref(APP, true), "https://app.example.com/done?popup=1"])("parseTarget.ok.only %s", (href) => {
  expect(parseTarget(href)).toBe(href);
});
`,
    });
    expect(cleared.untested).toEqual([]);
    const support = await untested({
      "src/target.ts": TARGET,
      "tests/support.ts": "export const href = (o: string): string => o + '/done?popup=1';\n",
      "tests/target.test.ts": `import { expect, it } from "bun:test";
import { parseTarget } from "../src/target";
import { href } from "./support";
it("parseTarget.ok.only", () => {
  expect(parseTarget(href("https://app.example.com"))).not.toBeNull();
});
`,
    });
    expect(support.untested.map((f) => f.message)).toEqual([
      'parseTarget commits to match "1" and the contract names it, but no linked test uses it; a test cannot fail when it changes',
    ]);
  });
});

describe("Step Summary: accepted in source (#48)", () => {
  test("lists tag-accepted findings with their reasons, even past 200 info findings", async () => {
    const many = Array.from(
      { length: 210 },
      (_, i) => `export function op${i}(v: string): string {\n  return v;\n}\n`,
    ).join("\n");
    const { report } = await untested({
      "src/many.ts": many,
      "src/adult.ts": `/**
 * @guarantee ok.adult an \`age\` of 18 or more is adult
 * @acceptFinding decision-untested "18" checked by the caller's tests
 */
export function isAdult(age: number): boolean {
  return age >= 18;
}
`,
      "tests/adult.test.ts": `import { expect, it } from "bun:test";
import { isAdult } from "../src/adult";
it("isAdult.ok.adult", () => {
  expect(isAdult(30)).toBe(true);
});
`,
    });
    const withInfo = {
      ...report,
      findings: report.findings.map((f) =>
        f.rule === "operation-no-guarantee" ? { ...f, severity: "info" as const } : f,
      ),
    };
    expect(withInfo.findings.filter((f) => f.severity === "info").length).toBeGreaterThan(200);
    const summary = renderStepSummary(withInfo);
    expect(summary).toContain("<summary>Accepted in source (<code>@acceptFinding</code>)</summary>");
    expect(summary).toContain("| checked by the caller's tests |");
    expect(renderStepSummary({ ...report, findings: [] })).not.toContain("Accepted in source");
  });
});
