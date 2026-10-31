/**
 * Test-time helpers imported by generated tests (`specgate/runtime`).
 *
 * @remarks
 * These are deliberately small and framework-free. A stub records calls so that frame
 * guarantees ("ports outside `@modifies` are untouched") can be asserted without a contract
 * fake; everything that needs real state (round-trip, atomicity, idempotence) is left to
 * contract-passing fakes the repository provides, and the generated test says so.
 */
export interface RecordedCall {
  member: string;
  args: unknown[];
}

interface StubControl {
  calls: RecordedCall[];
  returns: Map<string, unknown>;
  throws: Map<string, unknown>;
}

const controls = new WeakMap<object, StubControl>();

function controlOf(stub: object): StubControl {
  const control = controls.get(stub);
  if (!control) throw new Error("not a specgate stub");
  return control;
}

/** Structural check used instead of a type assertion: the object was built from T's member list. */
function builtAs<T>(value: object, members: ReadonlyArray<string>): value is T & object {
  return members.every((m) => m in value);
}

/**
 * Creates a stub implementing every listed member as a recording function.
 * Members return the value set with {@link stubReturns} (default `undefined`) or throw the
 * value set with {@link stubThrows}.
 */
export function createStub<T extends object>(members: ReadonlyArray<keyof T & string>): T {
  const control: StubControl = { calls: [], returns: new Map(), throws: new Map() };
  const target: Record<string, unknown> = {};
  for (const member of members) {
    target[member] = (...args: unknown[]): unknown => {
      control.calls.push({ member, args });
      if (control.throws.has(member)) throw control.throws.get(member);
      return control.returns.get(member);
    };
  }
  controls.set(target, control);
  if (!builtAs<T>(target, members)) throw new Error("stub construction failed");
  return target;
}

export function stubCalls(stub: object): RecordedCall[] {
  return [...controlOf(stub).calls];
}

export function stubReturns<T extends object>(stub: T, member: keyof T & string, value: unknown): void {
  controlOf(stub).returns.set(member, value);
}

export function stubThrows<T extends object>(stub: T, member: keyof T & string, error: unknown): void {
  controlOf(stub).throws.set(member, error);
}

export function stubReset(stub: object): void {
  const control = controlOf(stub);
  control.calls.length = 0;
  control.throws.clear();
}

/** Serialised call log; two equal snapshots mean the port was not touched in between. */
export function snapshot(stub: object): string {
  return JSON.stringify(controlOf(stub).calls);
}

export function snapshotAll(stubs: Record<string, object>, except: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, stub] of Object.entries(stubs)) if (!except.includes(name)) out[name] = snapshot(stub);
  return out;
}

export interface FakeClock {
  now(): Date;
  set(date: Date): void;
  advance(ms: number): void;
}

export function fakeClock(initial: Date = new Date("2026-01-01T00:00:00.000Z")): FakeClock {
  let current = new Date(initial.getTime());
  return {
    now: () => new Date(current.getTime()),
    set: (date) => {
      current = new Date(date.getTime());
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

export class InjectedFault extends Error {
  constructor(public readonly at: number) {
    super(`specgate: injected fault at transaction boundary ${at}`);
  }
}

export interface FaultRunnerControl {
  /** Fail the k-th boundary (1-based) of the next calls; 0 disables. */
  failAt(k: number): void;
  /** 1..n where n is the number of boundaries the last successful call opened. */
  failurePoints(): number[];
  reset(): void;
}

const runnerControls = new WeakMap<object, FaultRunnerControl>();

/**
 * A transaction-runner stub whose members accept a callback and run it, optionally throwing
 * before the k-th boundary. Used by generated atomicity tests.
 */
export function createFaultRunner<T extends object>(members: ReadonlyArray<keyof T & string>): T {
  let count = 0;
  let failAt = 0;
  let observed = 0;
  const target: Record<string, unknown> = {};
  for (const member of members) {
    target[member] = async (...args: unknown[]): Promise<unknown> => {
      count++;
      observed = Math.max(observed, count);
      if (failAt === count) throw new InjectedFault(count);
      const fn = args.find((a): a is (...inner: unknown[]) => unknown => typeof a === "function");
      return fn ? await fn({}) : undefined;
    };
  }
  runnerControls.set(target, {
    failAt: (k) => {
      failAt = k;
      count = 0;
    },
    failurePoints: () => Array.from({ length: observed }, (_, i) => i + 1),
    reset: () => {
      count = 0;
      failAt = 0;
    },
  });
  if (!builtAs<T>(target, members)) throw new Error("runner construction failed");
  return target;
}

export function faultRunnerControl(runner: object): FaultRunnerControl {
  const control = runnerControls.get(runner);
  if (!control) throw new Error("not a specgate fault runner");
  return control;
}

export interface ZodLike {
  safeParse(value: unknown): { success: boolean };
}

/**
 * Round-trip property for an entity schema: a value the schema accepts is accepted again after
 * parsing. Generated property tests call this with a fast-check arbitrary derived from the schema.
 */
export function acceptsAgain(schema: { parse(value: unknown): unknown } & ZodLike, value: unknown): boolean {
  const first = schema.safeParse(value);
  if (!first.success) return true; // out of domain: nothing to assert
  return schema.safeParse(schema.parse(value)).success;
}
