/**
 * Intermediate representation (IR) of one consistency-gate run.
 *
 * @remarks
 * The IR is the product. Consumers (dashboards, spec indexes, other tools) read only this
 * document and never the TypeScript sources, so every field here is language-neutral:
 * nothing refers to TypeScript node kinds, tracker IDs or a particular test runner.
 * Extractors for other languages are expected to emit the same shape.
 *
 * The normative JSON Schema lives in `schema/ir.schema.json`; it is generated from
 * `scripts/ir-schema.zod.ts` (a development-only Zod mirror of these types) and a test keeps
 * the three in step. At runtime only the structural guard {@link isReport} is needed, so the
 * published package carries no schema library.
 */
export type Severity = "fail" | "warn" | "info";

export type GuaranteeSource = "guarantee" | "throws" | "returns" | "invariant";

export interface ProvenanceCommit {
  commit: string;
  /** ISO 8601 author date */
  date: string;
  /** Pull request identifier parsed from the commit subject, opaque to the tool */
  pr?: string;
}

export interface Provenance {
  introduced?: ProvenanceCommit;
  lastChanged?: ProvenanceCommit;
}

export type ReferenceKind = "param" | "result" | "port" | "entity" | "operation" | "type" | "literal" | "unresolved";

export interface Reference {
  raw: string;
  kind: ReferenceKind;
  /** Unit id or declaration name the token resolved to */
  target?: string;
}

export interface Guarantee {
  /** Guarantee id inside its unit, e.g. ok.recorded */
  id: string;
  /** Fully qualified key as tests name it, e.g. Quest#create.ok.recorded */
  key: string;
  /** First id segment (ok / err / atomic / frame / idempotent / other) */
  kind: string;
  source: GuaranteeSource;
  text: string;
  /** sha256 of the normalised text; drives change detection */
  textHash: string;
  /** Error type for @throws guarantees */
  throws?: string;
  line: number;
  references: Reference[];
  /** Keys of tests that name this guarantee */
  tests: string[];
  provenance?: Provenance;
}

export interface Param {
  name: string;
  type: string;
  optional: boolean;
  doc?: string;
}

export interface Example {
  expression: string;
  expected: string;
  line: number;
}

export interface PortCall {
  port: string;
  member: string;
  count: number;
}

/**
 * `type`: an exported type alias or non-port interface with guarantees (what it accepts or
 * rejects). `entry`: a package entry (`package.json#exports` subpath) whose module has a
 * `@packageDocumentation` comment with guarantees. See docs/design/0001-type-and-entry-units.md.
 */
export type UnitKind = "function" | "method" | "port" | "type" | "entry";

export interface EntryInfo {
  /** `package.json#exports` subpath, e.g. "." or "./runtime" */
  subpath: string;
  /** Source module the guarantees are written in, relative to root */
  source: string;
  /** Export conditions and their targets as written in package.json */
  conditions: Record<string, string>;
}

/**
 * Kind of a value the implementation commits to: a `boundary` it compares against, a
 * `constant` it computes with, an `output` string it returns, a value it `match`es input to,
 * a `member` of a module-level collection it tests membership in.
 */
export type DecisionKind = "boundary" | "constant" | "output" | "match" | "member";

/**
 * How a unit tests membership in a collection: equality (`includes`, `has`, `in`), or whether
 * the input starts with, ends with or contains an element (`some((p) => v.startsWith(p))`).
 */
export type MemberProbe = "exact" | "prefix" | "suffix" | "contains";

export interface Decision {
  kind: DecisionKind;
  /** Source text of the expression or declaration, on one line, shortened */
  expression: string;
  line: number;
  /** The committed values, as text (numbers in JavaScript's `String(n)` form) */
  values: string[];
  /** Names of the constants involved, if any */
  names: string[];
  /**
   * `member` decisions: the collection constant the element is declared in, its module
   * (relative to root) and the lines of its declaration
   */
  collection?: { name: string; file: string; line: number; endLine: number };
  /** `member` decisions: how the unit compares its input with the element */
  probe?: MemberProbe;
  /**
   * `match` decisions: the constant key the compared value is read with (`params.get("popup")`,
   * `obj["popup"]`, `obj.popup`), so a test writing `"?popup=1"` uses the value `1`
   */
  key?: string;
}

export interface Unit {
  /** Target#operation for methods, operation for functions, interface name for ports */
  id: string;
  kind: UnitKind;
  target?: string;
  operation: string;
  /** Path relative to root, POSIX separators */
  file: string;
  line: number;
  endLine: number;
  /** Files outside the defining module that import this unit */
  referencedBy: string[];
  summary: string;
  remarks?: string;
  params: Param[];
  returns: string;
  uses: string[];
  modifies: string[];
  injectedPorts: Array<{ member: string; type: string; members: string[] }>;
  /** Ports actually called in the body, by injected member */
  portCalls: PortCall[];
  /** Other surface units called from the body */
  operationCalls: string[];
  envInputs: Array<{ expression: string; line: number }>;
  /** Values the implementation (and the helpers it reaches) commits to; see `decision-unspecified` */
  decisions: Decision[];
  /**
   * Lines (in `file`) of the private helpers and same-module functions the body reaches; the
   * decision walk and mutant mapping treat them as part of the unit. Absent when there are none.
   */
  helperRanges?: Array<{ line: number; endLine: number }>;
  /** Mutants of the unit in the mutation report (`mutation.report`), when one was read. */
  mutation?: MutationCounts;
  /** sha256 of the implementation body text */
  implHash: string;
  guarantees: Guarantee[];
  examples: Example[];
  supersedes?: string;
  /**
   * `@acceptFinding` tags: findings on this unit accepted in the source, with the reason. A field
   * is empty when the tag leaves it out (reported by `accept-tag-invalid`).
   */
  accepts?: AcceptTag[];
  hasDoc: boolean;
  /** `type` units: the declared type text (not expanded) */
  typeText?: string;
  /** `entry` units */
  entry?: EntryInfo;
}

/** One `@acceptFinding <rule> <target> <reason>` tag. */
export interface AcceptTag {
  rule: string;
  /** The value the finding quotes, `Mutator` / `Mutator:"replacement"` for a mutant, or `*` */
  target: string;
  reason: string;
  line: number;
}

/**
 * Mutants mapped to a unit, by outcome: `killed` (a status in `mutation.detected`), `survived`,
 * `noCoverage` (no test ran the mutated code), `ignored` (every other status).
 */
export interface MutationCounts {
  killed: number;
  survived: number;
  noCoverage: number;
  ignored: number;
}

/** A mutant from the mutation report that a finding is about. */
export interface FindingMutant {
  /** Mutant id as the report gives it */
  id: string;
  mutator: string;
  /** Replacement source text, on one line, shortened */
  replacement?: string;
  /** Status as the report gives it (Survived, NoCoverage, …) */
  status: string;
  line: number;
}

export interface Entity {
  name: string;
  file: string;
  line: number;
  properties: string[];
  invariants: Array<{ text: string; textHash: string }>;
  description: string;
}

export interface PortDecl {
  name: string;
  file: string;
  line: number;
  members: string[];
  /** Parameter names of the members; words a guarantee on this port may use. */
  vocabulary: string[];
  description: string;
}

/** `failing`: `test.failing` (bun, jest) / `test.fails` (vitest), a test expected to fail. */
export type TestStatus = "test" | "todo" | "skip" | "each" | "failing";

export interface TestCase {
  /** Guarantee key the test names, e.g. Quest#create.ok.recorded */
  key: string;
  unitId?: string;
  guaranteeId?: string;
  file: string;
  line: number;
  title: string;
  status: TestStatus;
  bodyHash: string;
  /**
   * Literal values the test body and its `each` tables use, plus same-file module-level
   * constants they reference by name (one hop): non-empty strings as written, template parts
   * with a word character, numbers other than 0, 1 and -1 as `String(n)`. Capped at
   * `tests.literalLimit`.
   */
  literals: string[];
  /**
   * Identifier and string keys of the object literals the test body and its `each` tables write,
   * plus those of same-file module-level constants they reference by name (one hop), e.g. `iss`
   * in `sign({ iss: "https://evil.example" })`. Capped at `tests.literalLimit`.
   */
  keys: string[];
  /**
   * Imported constants the test takes its cases from (`each` table argument, `for…of`, the
   * receiver of `forEach` / `map` / `every` / `some`, or `new Set(X)` / `[...X]` /
   * `Array.from(X)`), with the module they come from (relative to root when it resolves to a
   * file, the import specifier otherwise).
   */
  iterates: Array<{ name: string; from: string }>;
  /** Opaque frozen-requirement ids from the file header, if enabled */
  requirementIds: string[];
}

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  unit?: string;
  guarantee?: string;
  test?: string;
  /**
   * Accepted: recorded in the accepted-findings file (`check --accept-baseline`) or by an
   * `@acceptFinding` tag; reported as `info`.
   */
  accepted?: boolean;
  /** The reason an `@acceptFinding` tag gives; absent for the accepted-findings file. */
  acceptedReason?: string;
  /** `mutant-survived`: the mutant the finding is about */
  mutant?: FindingMutant;
}

export interface Summary {
  units: number;
  unitsWithoutGuarantee: number;
  guarantees: number;
  guaranteesWithoutTest: number;
  tests: number;
  orphanTests: number;
  /** Tests whose title names no guarantee key at all */
  unlinkedTests: number;
  findings: { fail: number; warn: number; info: number };
}

export interface Report {
  $schema?: string;
  version: "1";
  tool: { name: string; version: string };
  generatedAt: string;
  root: string;
  /**
   * The commit the analysed checkout was on, read from `.git` (absent outside a git checkout).
   * A baseline from another revision may come from another branch; see `baseline-stale`.
   */
  revision?: string;
  /** Hash of the resolved config (without `root`); a baseline under another config is stale too. */
  configHash?: string;
  mode: "advisory" | "blocking";
  units: Unit[];
  vocabulary: { entities: Entity[]; ports: PortDecl[] };
  tests: TestCase[];
  findings: Finding[];
  summary: Summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isGuarantee(value: unknown): value is Guarantee {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["key"] === "string" &&
    typeof value["kind"] === "string" &&
    typeof value["text"] === "string" &&
    typeof value["textHash"] === "string" &&
    typeof value["line"] === "number" &&
    Array.isArray(value["references"]) &&
    isStringArray(value["tests"])
  );
}

function isUnit(value: unknown): value is Unit {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    (value["kind"] === "function" ||
      value["kind"] === "method" ||
      value["kind"] === "port" ||
      value["kind"] === "type" ||
      value["kind"] === "entry") &&
    typeof value["operation"] === "string" &&
    typeof value["file"] === "string" &&
    typeof value["line"] === "number" &&
    typeof value["implHash"] === "string" &&
    Array.isArray(value["guarantees"]) &&
    value["guarantees"].every(isGuarantee) &&
    (value["supersedes"] === undefined || typeof value["supersedes"] === "string")
  );
}

function isTestCase(value: unknown): value is TestCase {
  return (
    isRecord(value) &&
    typeof value["key"] === "string" &&
    typeof value["file"] === "string" &&
    typeof value["line"] === "number" &&
    typeof value["bodyHash"] === "string" &&
    typeof value["title"] === "string"
  );
}

/**
 * Structural check for a report read back from disk (the baseline for change detection).
 * It verifies the fields the rules depend on; a report that passes is safe to feed to the
 * rule engine. Full validation against the JSON Schema is left to consumers.
 */
export function isReport(value: unknown): value is Report {
  return (
    isRecord(value) &&
    value["version"] === "1" &&
    isRecord(value["tool"]) &&
    typeof value["generatedAt"] === "string" &&
    typeof value["root"] === "string" &&
    (value["mode"] === "advisory" || value["mode"] === "blocking") &&
    Array.isArray(value["units"]) &&
    value["units"].every(isUnit) &&
    Array.isArray(value["tests"]) &&
    value["tests"].every(isTestCase) &&
    Array.isArray(value["findings"]) &&
    isRecord(value["vocabulary"]) &&
    isRecord(value["summary"])
  );
}
