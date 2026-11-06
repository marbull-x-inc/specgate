import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyze, TOOL } from "../../src/analyze.ts";
import { defineConfig } from "../../src/config/schema.ts";
import type { Decision, Unit } from "../../src/ir/schema.ts";
import { listValueMutants, type ValueMutant } from "../../src/mutants/index.ts";
import { workDir } from "../helpers/paths.ts";

/**
 * #61: `decisions.widen` reaches the sites of #60's holes that 0.5's walk does not, one fixture
 * per row of the issue's table. Each widened decision has a value mutant that names it.
 */
function project(files: Record<string, string>): string {
  const dir = workDir("widen");
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

async function run(source: string, widen: boolean) {
  const dir = project({ "src/m.ts": source });
  const config = {
    ...defineConfig({
      root: dir,
      surface: { include: ["src/**/*.ts"], exclude: [], mode: "exported" },
      tests: { include: ["tests/**/*.test.ts"] },
      decisions: { widen },
    }),
    root: dir,
  };
  const { report, host } = await analyze(config, { provenance: false, baseline: null });
  const list = listValueMutants(report.units, host, dir, TOOL);
  const unit = (id: string): Unit => {
    const u = report.units.find((x) => x.id === id);
    if (!u) throw new Error(`no unit ${id}`);
    return u;
  };
  return { report, unit, mutants: list.mutants };
}

const has = (u: Unit, kind: Decision["kind"], value: string): Decision | undefined =>
  u.decisions.find((d) => d.kind === kind && d.values.includes(value));

const mutantFor = (mutants: readonly ValueMutant[], kind: Decision["kind"], value: string): ValueMutant | undefined =>
  mutants.find((m) => m.decision?.kind === kind && m.decision.values.includes(value));

const DEFAULTS = `/**
 * @guarantee ok.count returns a counter starting at the given value
 */
export function useCounter(initialValue = 0, { delta = 1, label = "count" }: { delta?: number; label?: string } = {}) {
  return { value: initialValue, step: delta, label };
}
`;

const OFFSETS = `/**
 * @guarantee ok.offset returns the index after the boundary, never negative
 */
export function after(boundaries: number, shift: number): number {
  return Math.max(0, boundaries + 1 - shift);
}

/**
 * @guarantee ok.index returns the next slot of a list
 */
export function next(values: number[], i: number): number | undefined {
  return values[i + 1];
}
`;

const LOCAL = `const STR_SPLITTERS = ["-", "_", "/", "."];

/**
 * @guarantee ok.split splits on the given separators
 */
export function splitByCase(input: string, separators?: string[]): string[] {
  const splitters = separators ?? STR_SPLITTERS;
  const out: string[] = [];
  let cur = "";
  for (const c of input) {
    if (splitters.includes(c)) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  return [...out, cur];
}
`;

const REGEX = `const SMALL = /^(of|to|in)$/;

/**
 * @guarantee ok.title keeps articles and short words lower case
 */
export function isSmallWord(p: string): boolean {
  return /^(a|an|and|the)$/i.test(p) || SMALL.test(p);
}
`;

const CONSTRUCTOR = `class Reply {
  constructor(
    readonly body: string,
    readonly init: { status: number; statusText?: string },
  ) {}
}

/**
 * @guarantee err.size returns an error reply when the body is too large
 */
export function tooLarge(msg: string): Reply {
  const reply = new Reply(msg, { status: 413, statusText: "Payload Too Large" });
  return reply;
}
`;

const ARGUMENTS = `interface Ctx {
  res: { headers: { delete(name: string): void; set(name: string, value: string): void } };
}

/**
 * @guarantee ok.strip removes the length header and returns a fresh key
 */
export function strip(c: Ctx): Uint8Array {
  c.res.headers.delete("Content-Length");
  c.res.headers.set("Vary", "Origin");
  const key = new Uint8Array(16);
  return key;
}

export interface Store {
  save(key: string, ttl: number): void;
}

export class Cache {
  constructor(private readonly store: Store) {}
  /**
   * @guarantee ok.put stores the entry
   */
  put(): void {
    this.store.save("entry", 3600);
    console.log("saved", 42);
  }
}
`;

describe("decisions.widen (#61)", () => {
  test("default parameters and destructured defaults are constants, 0 and 1 included", async () => {
    const off = await run(DEFAULTS, false);
    expect(has(off.unit("useCounter"), "constant", "0")).toBeUndefined();
    const { unit, mutants } = await run(DEFAULTS, true);
    const u = unit("useCounter");
    for (const v of ["0", "1", "count"]) expect(has(u, "constant", v)).toBeDefined();
    expect(mutantFor(mutants, "constant", "0")?.description).toBe("the default `initialValue` 0 → 1");
    expect(mutantFor(mutants, "constant", "1")?.description).toBe("the default `delta` 1 → 2");
    expect(mutantFor(mutants, "constant", "count")).toBeDefined();
  });

  test("an offset from a parameter and a Math.max limit are boundaries; an index offset is not", async () => {
    const off = await run(OFFSETS, false);
    expect(off.unit("after").decisions).toEqual([]);
    const { unit, mutants } = await run(OFFSETS, true);
    const d = has(unit("after"), "boundary", "1");
    expect(d?.expression).toBe("boundaries + 1");
    expect(has(unit("after"), "boundary", "0")?.expression).toStartWith("Math.max(0,");
    expect(mutantFor(mutants, "boundary", "1")).toBeDefined();
    expect(mutantFor(mutants, "boundary", "0")).toBeDefined();
    // `values[i + 1]` lays out an internal array (#68).
    expect(unit("next").decisions).toEqual([]);
  });

  test("a local initialised from a module collection is probed as that collection", async () => {
    const off = await run(LOCAL, false);
    expect(off.unit("splitByCase").decisions.filter((d) => d.kind === "member")).toEqual([]);
    const { unit, mutants } = await run(LOCAL, true);
    const members = unit("splitByCase").decisions.filter((d) => d.kind === "member");
    expect(members.map((d) => d.values[0])).toEqual(["-", "_", "/", "."]);
    expect(members[0]?.collection?.name).toBe("STR_SPLITTERS");
    expect(members[0]?.names).toEqual(["splitters", "STR_SPLITTERS"]);
    const m = mutantFor(mutants, "member", "_");
    expect(m?.description).toBe('`"_"` removed from `STR_SPLITTERS`');
    expect(m?.kind).toBe("element");
  });

  test("a regex word group gives one exact member per word, inline or in a module constant", async () => {
    const off = await run(REGEX, false);
    expect(off.unit("isSmallWord").decisions).toEqual([]);
    const { unit, mutants } = await run(REGEX, true);
    const members = unit("isSmallWord").decisions.filter((d) => d.kind === "member");
    expect(members.map((d) => d.values[0]).sort()).toEqual(["a", "an", "and", "in", "of", "the", "to"]);
    expect(members.every((d) => d.probe === "exact")).toBe(true);
    expect(members.find((d) => d.values[0] === "an")?.collection?.name).toBe("regex at line 7");
    expect(members.find((d) => d.values[0] === "of")?.collection?.name).toBe("SMALL");
    const an = mutantFor(mutants, "member", "an");
    expect(an?.kind).toBe("alternative");
    expect(mutantFor(mutants, "member", "of")?.kind).toBe("alternative");
  });

  test("literal properties of an object passed to new X(…) are outputs", async () => {
    const off = await run(CONSTRUCTOR, false);
    expect(has(off.unit("tooLarge"), "output", "413")).toBeUndefined();
    const { unit, mutants } = await run(CONSTRUCTOR, true);
    expect(has(unit("tooLarge"), "output", "413")?.expression).toBe("status: 413");
    expect(has(unit("tooLarge"), "output", "Payload Too Large")).toBeDefined();
    expect(mutantFor(mutants, "output", "413")?.description).toBe("`status` 413 → 414");
  });

  test("literal arguments of calls on a parameter or a port, and of new X(…), are outputs", async () => {
    const off = await run(ARGUMENTS, false);
    expect(has(off.unit("strip"), "output", "Content-Length")).toBeUndefined();
    const { unit, mutants } = await run(ARGUMENTS, true);
    const strip = unit("strip");
    for (const v of ["Content-Length", "Vary", "Origin", "16"]) expect(has(strip, "output", v)).toBeDefined();
    expect(mutantFor(mutants, "output", "Content-Length")).toBeDefined();
    expect(mutantFor(mutants, "output", "16")).toBeDefined();
    const put = unit("Cache#put");
    expect(has(put, "output", "entry")).toBeDefined();
    expect(has(put, "output", "3600")).toBeDefined();
    // `console` is neither a parameter nor a port.
    expect(has(put, "output", "saved")).toBeUndefined();
  });
});
