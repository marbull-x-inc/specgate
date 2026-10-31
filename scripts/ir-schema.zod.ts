import { z } from "zod";

/**
 * Development-only Zod mirror of the IR types in `src/ir/schema.ts`.
 *
 * @remarks
 * Zod is not a runtime dependency of the published package. This file exists to emit
 * `schema/ir.schema.json` (`bun run schema:emit`) and to validate reports in tests;
 * `tests/unit/ir-schema.test.ts` checks at compile time that `z.infer<typeof zReport>` and
 * the hand-written `Report` type are assignable to each other, so the two cannot drift.
 * The IR is the product. Consumers (dashboards, spec indexes, other tools) read only this
 * document and never the TypeScript sources, so every field here is language-neutral:
 * nothing refers to TypeScript node kinds, tracker IDs or a particular test runner.
 * Extractors for other languages are expected to emit the same shape.
 */
export const zSeverity = z.enum(["fail", "warn", "info"]);
export type Severity = z.infer<typeof zSeverity>;

export const zGuaranteeSource = z.enum(["guarantee", "throws", "returns", "invariant"]);

export const zProvenanceCommit = z.object({
  commit: z.string(),
  date: z.string().describe("ISO 8601 author date"),
  pr: z.string().optional().describe("Pull request identifier parsed from the commit subject, opaque to the tool"),
});
export type ProvenanceCommit = z.infer<typeof zProvenanceCommit>;

export const zProvenance = z.object({
  introduced: zProvenanceCommit.optional(),
  lastChanged: zProvenanceCommit.optional(),
});

export const zReference = z.object({
  raw: z.string(),
  kind: z.enum(["param", "result", "port", "entity", "operation", "type", "literal", "unresolved"]),
  target: z.string().optional().describe("Unit id or declaration name the token resolved to"),
});
export type Reference = z.infer<typeof zReference>;

export const zGuarantee = z.object({
  id: z.string().describe("Guarantee id inside its unit, e.g. ok.recorded"),
  key: z.string().describe("Fully qualified key as tests name it, e.g. Quest#create.ok.recorded"),
  kind: z.string().describe("First id segment (ok / err / atomic / frame / idempotent / other)"),
  source: zGuaranteeSource,
  text: z.string(),
  textHash: z.string().describe("sha256 of the normalised text; drives change detection"),
  throws: z.string().optional().describe("Error type for @throws guarantees"),
  line: z.number().int(),
  references: z.array(zReference),
  tests: z.array(z.string()).describe("Keys of tests that name this guarantee"),
  provenance: zProvenance.optional(),
});
export type Guarantee = z.infer<typeof zGuarantee>;

export const zParam = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean(),
  doc: z.string().optional(),
});

export const zExample = z.object({ expression: z.string(), expected: z.string(), line: z.number().int() });

export const zPortCall = z.object({ port: z.string(), member: z.string(), count: z.number().int() });

export const zUnitKind = z.enum(["function", "method", "port"]);
export type UnitKind = z.infer<typeof zUnitKind>;

export const zUnit = z.object({
  id: z.string().describe("Target#operation for methods, operation for functions, interface name for ports"),
  kind: zUnitKind,
  target: z.string().optional(),
  operation: z.string(),
  file: z.string().describe("Path relative to root, POSIX separators"),
  line: z.number().int(),
  endLine: z.number().int(),
  referencedBy: z.array(z.string()).describe("Files outside the defining module that import this unit"),
  summary: z.string(),
  remarks: z.string().optional(),
  params: z.array(zParam),
  returns: z.string(),
  uses: z.array(z.string()),
  modifies: z.array(z.string()),
  injectedPorts: z.array(z.object({ member: z.string(), type: z.string(), members: z.array(z.string()) })),
  portCalls: z.array(zPortCall).describe("Ports actually called in the body, by injected member"),
  operationCalls: z.array(z.string()).describe("Other surface units called from the body"),
  envInputs: z.array(z.object({ expression: z.string(), line: z.number().int() })),
  implHash: z.string().describe("sha256 of the implementation body text"),
  guarantees: z.array(zGuarantee),
  examples: z.array(zExample),
  supersedes: z.string().optional(),
  hasDoc: z.boolean(),
});
export type Unit = z.infer<typeof zUnit>;

export const zEntity = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
  properties: z.array(z.string()),
  invariants: z.array(z.object({ text: z.string(), textHash: z.string() })),
  description: z.string(),
});
export type Entity = z.infer<typeof zEntity>;

export const zPortDecl = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
  members: z.array(z.string()),
  /** Parameter names of the members; words a guarantee on this port may use. */
  vocabulary: z.array(z.string()),
  description: z.string(),
});
export type PortDecl = z.infer<typeof zPortDecl>;

export const zTestStatus = z.enum(["test", "todo", "skip", "each"]);

export const zTestCase = z.object({
  key: z.string().describe("Guarantee key the test names, e.g. Quest#create.ok.recorded"),
  unitId: z.string().optional(),
  guaranteeId: z.string().optional(),
  file: z.string(),
  line: z.number().int(),
  title: z.string(),
  status: zTestStatus,
  bodyHash: z.string(),
  requirementIds: z.array(z.string()).describe("Opaque frozen-requirement ids from the file header, if enabled"),
});
export type TestCase = z.infer<typeof zTestCase>;

export const zFinding = z.object({
  rule: z.string(),
  severity: zSeverity,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  unit: z.string().optional(),
  guarantee: z.string().optional(),
  test: z.string().optional(),
});
export type Finding = z.infer<typeof zFinding>;

export const zSummary = z.object({
  units: z.number().int(),
  unitsWithoutGuarantee: z.number().int(),
  guarantees: z.number().int(),
  guaranteesWithoutTest: z.number().int(),
  tests: z.number().int(),
  orphanTests: z.number().int(),
  unlinkedTests: z.number().int().describe("Tests whose title names no guarantee key at all"),
  findings: z.object({ fail: z.number().int(), warn: z.number().int(), info: z.number().int() }),
});

export const zReport = z.object({
  $schema: z.string().optional(),
  version: z.literal("1"),
  tool: z.object({ name: z.string(), version: z.string() }),
  generatedAt: z.string(),
  root: z.string(),
  mode: z.enum(["advisory", "blocking"]),
  units: z.array(zUnit),
  vocabulary: z.object({ entities: z.array(zEntity), ports: z.array(zPortDecl) }),
  tests: z.array(zTestCase),
  findings: z.array(zFinding),
  summary: zSummary,
});
export type Report = z.infer<typeof zReport>;

/** Emits the JSON Schema of the IR. Committed under schema/ir.schema.json and checked by a test. */
export function irJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(zReport, { target: "draft-2020-12", io: "output" });
}
