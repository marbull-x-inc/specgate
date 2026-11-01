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

export type UnitKind = "function" | "method" | "port";

/**
 * Kind of a value the implementation commits to: a `boundary` it compares against, a
 * `constant` it computes with, an `output` string it returns, a value it `match`es input to.
 */
export type DecisionKind = "boundary" | "constant" | "output" | "match";

export interface Decision {
  kind: DecisionKind;
  /** Source text of the expression or declaration, on one line, shortened */
  expression: string;
  line: number;
  /** The committed values, as text (numbers in JavaScript's `String(n)` form) */
  values: string[];
  /** Names of the constants involved, if any */
  names: string[];
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
  /** sha256 of the implementation body text */
  implHash: string;
  guarantees: Guarantee[];
  examples: Example[];
  supersedes?: string;
  hasDoc: boolean;
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

export type TestStatus = "test" | "todo" | "skip" | "each";

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
    (value["kind"] === "function" || value["kind"] === "method" || value["kind"] === "port") &&
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
