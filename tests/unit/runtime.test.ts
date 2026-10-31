import { describe, expect, test } from "bun:test";
import {
  acceptsAgain,
  arbitraryFromZod,
  createFaultRunner,
  createStub,
  fakeClock,
  faultRunnerControl,
  InjectedFault,
  snapshot,
  snapshotAll,
  stubCalls,
  stubReset,
  stubReturns,
  stubThrows,
} from "../../src/runtime/index.ts";

interface Repo {
  findById(id: string): Promise<{ id: string } | null>;
  save(v: { id: string }): Promise<void>;
}
interface Runner {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

describe("createStub", () => {
  test("records calls, returns configured values, throws configured errors, snapshots change only on calls", async () => {
    const repo = createStub<Repo>(["findById", "save"]);
    const before = snapshot(repo);
    stubReturns(repo, "findById", Promise.resolve({ id: "a" }));
    expect(await repo.findById("a")).toEqual({ id: "a" });
    expect(stubCalls(repo)).toEqual([{ member: "findById", args: ["a"] }]);
    expect(snapshot(repo)).not.toBe(before);
    stubThrows(repo, "save", new Error("boom"));
    expect(() => repo.save({ id: "a" })).toThrow("boom");
    stubReset(repo);
    expect(snapshot(repo)).toBe(before);
    expect(snapshotAll({ repo }, ["repo"])).toEqual({});
  });
});

describe("fakeClock", () => {
  test("is fixed until moved", () => {
    const clock = fakeClock(new Date("2026-01-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(1000);
    expect(clock.now().getTime()).toBe(Date.UTC(2026, 0, 1, 0, 0, 1));
    clock.set(new Date(0));
    expect(clock.now().getTime()).toBe(0);
  });
});

describe("createFaultRunner", () => {
  test("counts boundaries on a successful call and fails at the k-th one afterwards", async () => {
    const tx = createFaultRunner<Runner>(["run"]);
    const op = async () => {
      await tx.run(async () => 1);
      await tx.run(async () => 2);
      return "done";
    };
    expect(await op()).toBe("done");
    expect(faultRunnerControl(tx).failurePoints()).toEqual([1, 2]);
    faultRunnerControl(tx).failAt(2);
    await expect(op()).rejects.toBeInstanceOf(InjectedFault);
    faultRunnerControl(tx).reset();
    expect(await op()).toBe("done");
  });
});

describe("acceptsAgain", () => {
  test("holds for a schema-like object that is idempotent under parse", () => {
    const schema = { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: typeof v === "number" }) };
    expect(acceptsAgain(schema, 1)).toBe(true);
    expect(acceptsAgain(schema, "x")).toBe(true);
  });
});

describe("arbitraryFromZod", () => {
  test("generates values inside the schema's domain, including refinements", async () => {
    const fc = await import("fast-check");
    const { z } = await import("zod");
    const zMoney = z.object({ amount: z.number().int().nonnegative(), currency: z.string().length(3) });
    const zPeriod = z.object({ start: z.date(), end: z.date() }).refine((p) => p.start.getTime() <= p.end.getTime());
    const zMixed = z.object({
      kind: z.enum(["A", "B"]),
      tags: z.array(z.string().min(1)).max(3),
      score: z.number().min(1).max(5),
      note: z.string().nullable(),
      when: z.date().optional(),
      lit: z.literal("x"),
      u: z.union([z.boolean(), z.number().int()]),
    });
    for (const schema of [zMoney, zPeriod, zMixed]) {
      const samples = fc.sample(arbitraryFromZod(fc, schema), 30);
      expect(samples).toHaveLength(30);
      for (const s of samples) expect(schema.safeParse(s).success).toBe(true);
    }
  });
  test("falls back to anything() for schemas it does not understand", async () => {
    const fc = await import("fast-check");
    expect(fc.sample(arbitraryFromZod(fc, { not: "a schema" }), 3)).toHaveLength(3);
  });
});
