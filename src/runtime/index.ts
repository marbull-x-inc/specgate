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

/**
 * The subset of fast-check this module needs. Kept structural so that `specgate/runtime`
 * does not depend on fast-check's types; the generated test passes its own `fc` in.
 */
export interface ArbitraryFactory<Arb> {
  integer(constraints?: { min?: number; max?: number }): Arb;
  double(constraints?: { min?: number; max?: number; noNaN?: boolean }): Arb;
  string(constraints?: { minLength?: number; maxLength?: number }): Arb;
  boolean(): Arb;
  date(constraints?: { min?: Date; max?: Date }): Arb;
  constant(value: unknown): Arb;
  constantFrom(...values: unknown[]): Arb;
  oneof(...arbitraries: Arb[]): Arb;
  array(arbitrary: Arb, constraints?: { minLength?: number; maxLength?: number }): Arb;
  record(shape: Record<string, Arb>): Arb;
  option(arbitrary: Arb, constraints?: { nil?: unknown }): Arb;
  anything(): Arb;
}

interface FilterableArb {
  filter(predicate: (value: unknown) => boolean): unknown;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ZodDefLike {
  type: string;
  checks: Array<Record<string, unknown>>;
  shape: Record<string, unknown> | undefined;
  innerType: unknown;
  element: unknown;
  entries: Record<string, unknown> | undefined;
  values: unknown[] | undefined;
  options: unknown[] | undefined;
}

/** Reads a Zod 4 schema's internal definition without depending on zod's types. */
function zodDef(schema: unknown): ZodDefLike | undefined {
  if (!isRecordValue(schema)) return undefined;
  const internals = schema["_zod"];
  if (!isRecordValue(internals)) return undefined;
  const def = internals["def"];
  if (!isRecordValue(def) || typeof def["type"] !== "string") return undefined;
  const checks: Array<Record<string, unknown>> = [];
  if (Array.isArray(def["checks"])) {
    for (const check of def["checks"]) {
      if (!isRecordValue(check)) continue;
      const inner = check["_zod"];
      const checkDef = isRecordValue(inner) ? inner["def"] : undefined;
      if (isRecordValue(checkDef)) checks.push(checkDef);
    }
  }
  return {
    type: def["type"],
    checks,
    shape: isRecordValue(def["shape"]) ? def["shape"] : undefined,
    innerType: def["innerType"],
    element: def["element"],
    entries: isRecordValue(def["entries"]) ? def["entries"] : undefined,
    values: Array.isArray(def["values"]) ? def["values"] : undefined,
    options: Array.isArray(def["options"]) ? def["options"] : undefined,
  };
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Derives a fast-check arbitrary from a Zod 4 schema so that property tests generate values
 * inside the schema's domain instead of filtering `fc.anything()` (which practically never
 * hits an object shape). Structure, enums, literals, unions, optionals, nullables, arrays,
 * string lengths and numeric bounds are honoured; refinements are applied as a final
 * `safeParse` filter, so keep them likely to hold (for example `start <= end`).
 */
/** The arbitrary type a factory produces, taken from `anything()` so that inference is not pulled by parameter unions. */
export type ArbitraryOf<F> = F extends { anything(): infer A } ? A : never;

export function arbitraryFromZod<F extends ArbitraryFactory<ArbitraryOf<F>>>(fc: F, schema: unknown): ArbitraryOf<F> {
  const built = build<ArbitraryOf<F>>(fc, schema, 0);
  if (!isFilterable(built) || !isParser(schema)) return built;
  const filtered = built.filter((value) => schema.safeParse(value).success === true);
  return isArbOf(filtered, built) ? filtered : built;
}

function isFilterable(value: unknown): value is FilterableArb {
  return isRecordValue(value) && typeof value["filter"] === "function";
}

function isParser(value: unknown): value is ZodLike {
  return isRecordValue(value) && typeof value["safeParse"] === "function";
}

/** `filter` returns the same arbitrary type; this check stands in for an assertion. */
function isArbOf<Arb>(value: unknown, sample: Arb): value is Arb {
  return typeof value === typeof sample && value !== null;
}

function build<Arb>(fc: ArbitraryFactory<Arb>, schema: unknown, depth: number): Arb {
  const def = zodDef(schema);
  if (!def || depth > 6) return fc.anything();
  switch (def.type) {
    case "string": {
      let minLength: number | undefined;
      let maxLength: number | undefined;
      for (const c of def.checks) {
        if (c["check"] === "min_length") minLength = numberOf(c["minimum"]);
        if (c["check"] === "max_length") maxLength = numberOf(c["maximum"]);
        if (c["check"] === "length_equals") {
          minLength = numberOf(c["length"]);
          maxLength = minLength;
        }
      }
      return fc.string({
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
      });
    }
    case "number": {
      let min: number | undefined;
      let max: number | undefined;
      let integer = false;
      for (const c of def.checks) {
        if (c["check"] === "number_format" && typeof c["format"] === "string" && /int/.test(c["format"]))
          integer = true;
        if (c["check"] === "greater_than") {
          const v = numberOf(c["value"]);
          if (v !== undefined) min = c["inclusive"] === true ? v : v + (integer ? 1 : Number.EPSILON);
        }
        if (c["check"] === "less_than") {
          const v = numberOf(c["value"]);
          if (v !== undefined) max = c["inclusive"] === true ? v : v - (integer ? 1 : Number.EPSILON);
        }
      }
      const bounds = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
      return integer ? fc.integer(bounds) : fc.double({ ...bounds, noNaN: true });
    }
    case "boolean":
      return fc.boolean();
    case "date":
      return fc.date({ min: new Date("1970-01-01T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z") });
    case "literal":
      return fc.constantFrom(...(def.values ?? []));
    case "enum":
      return fc.constantFrom(...Object.values(def.entries ?? {}));
    case "optional":
      return fc.option(build(fc, def.innerType, depth + 1), { nil: undefined });
    case "nullable":
      return fc.option(build(fc, def.innerType, depth + 1), { nil: null });
    case "default":
    case "nonoptional":
    case "readonly":
    case "catch":
      return build(fc, def.innerType, depth + 1);
    case "array": {
      let maxLength = 5;
      let minLength = 0;
      for (const c of def.checks) {
        if (c["check"] === "max_length") maxLength = numberOf(c["maximum"]) ?? maxLength;
        if (c["check"] === "min_length") minLength = numberOf(c["minimum"]) ?? minLength;
      }
      return fc.array(build(fc, def.element, depth + 1), { minLength, maxLength });
    }
    case "union": {
      const options = (def.options ?? []).map((o) => build(fc, o, depth + 1));
      return options.length > 0 ? fc.oneof(...options) : fc.anything();
    }
    case "object": {
      const shape: Record<string, Arb> = {};
      for (const [key, value] of Object.entries(def.shape ?? {})) shape[key] = build(fc, value, depth + 1);
      return fc.record(shape);
    }
    default:
      return fc.anything();
  }
}
