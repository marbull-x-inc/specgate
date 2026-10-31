import type { Config } from "../config/schema.ts";
import type { Entity, PortDecl, Reference, Unit } from "../ir/schema.ts";

/**
 * Resolves the identifiers a guarantee mentions.
 *
 * @remarks
 * A guarantee may only speak about what its caller can observe: the parameters, `result`, the
 * ports declared in `@uses` / `@modifies`, vocabulary (`@entity`) and the guarantees of other
 * public operations. Anything else is an implementation detail leaking into the specification,
 * so it is reported as unresolved. Prose is not parsed; only tokens shaped like code are
 * examined: dotted paths (`period.start`, `Clock.now`), `Target#op.id` references, PascalCase
 * names and SCREAMING_CASE constants. Lowercase single words are treated as prose.
 */
export interface ResolutionScope {
  units: readonly Unit[];
  entities: readonly Entity[];
  ports: readonly PortDecl[];
  programTypeNames: ReadonlySet<string>;
}

const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "result", "this"]);

const DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const OPERATION_REF = /^(?<target>[A-Za-z_$][\w$]*)?#(?<operation>[A-Za-z_$][\w$]*)(?:\.(?<id>[A-Za-z0-9.\-_*]+))?$/;
const PASCAL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$|^I[A-Z][A-Za-z0-9]+$/;
const SCREAMING = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{3,}$/;

function tokenize(text: string): string[] {
  // Strip quoted literals and code-span backticks, then split on whitespace and punctuation that cannot be part of a token.
  const withoutQuotes = text.replace(/"[^"]*"|'[^']*'/g, " ");
  return withoutQuotes
    .replace(/`/g, " ")
    .split(/[\s,;:()[\]{}=<>≤≥∈∉∧∨→+/!?|&^~%]+/)
    .map((t) => t.replace(/^[.]+|[.]+$/g, "").replace(/^\*+|(?<!\.)\*+$/g, ""))
    .filter((t) => t.length > 0 && /^[\x21-\x7e]+$/.test(t));
}

function uniqueByOperation(units: readonly Unit[], operation: string): Unit | undefined {
  const matches = units.filter((u) => u.operation === operation);
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveReferences(unit: Unit, text: string, scope: ResolutionScope, config: Config): Reference[] {
  const refs: Reference[] = [];
  const paramNames = new Set(unit.params.map((p) => p.name));
  const declaredPorts = new Set([...unit.uses, ...unit.modifies]);
  const portNames = new Set(scope.ports.map((p) => p.name));
  const portTypes = new Map(unit.injectedPorts.map((p) => [p.type, p.member] as const));
  const entityNames = new Set(scope.entities.map((e) => e.name));
  const entityProps = new Set(scope.entities.flatMap((e) => e.properties));
  const unitIds = new Map(scope.units.map((u) => [u.id, u] as const));
  const portsByName = new Map(scope.ports.map((p) => [p.name, p] as const));
  // Members (and their parameter names) of the ports this unit may speak about.
  const portMembers = new Set<string>();
  const addPortWords = (portName: string): void => {
    const decl = portsByName.get(portName);
    if (decl) for (const w of [...decl.members, ...decl.vocabulary]) portMembers.add(w);
    for (const injected of unit.injectedPorts)
      if (injected.type === portName) for (const m of injected.members) portMembers.add(m);
  };
  for (const p of declaredPorts) addPortWords(p);
  if (unit.kind === "port") addPortWords(unit.id);
  const ignore = new Set(config.resolve.ignore);
  const seen = new Set<string>();

  const pushRef = (raw: string, kind: Reference["kind"], target?: string): void => {
    if (seen.has(raw)) return;
    seen.add(raw);
    refs.push({ raw, kind, ...(target ? { target } : {}) });
  };

  const resolveRoot = (root: string): Reference["kind"] | undefined => {
    if (paramNames.has(root)) return "param";
    if (root === "result") return "result";
    if (portMembers.has(root)) return "port";
    if (declaredPorts.has(root) || portNames.has(root) || portTypes.has(root)) return "port";
    if (entityNames.has(root)) return "entity";
    if (LITERALS.has(root)) return "literal";
    return undefined;
  };

  for (const token of tokenize(text)) {
    if (ignore.has(token) || LITERALS.has(token) || /^\d/.test(token)) continue;
    const op = OPERATION_REF.exec(token);
    if (op?.groups) {
      const target = op.groups["target"];
      const operation = op.groups["operation"] ?? "";
      const id = op.groups["id"];
      // "#op" without a target: the current class first, then any unit with that operation name if unique.
      const unitId = target ? `${target}#${operation}` : operation;
      const other =
        unitIds.get(unitId) ??
        (target === undefined
          ? (unitIds.get(`${unit.target ?? ""}#${operation}`) ?? uniqueByOperation(scope.units, operation))
          : undefined);
      if (!other) {
        pushRef(token, "unresolved");
        continue;
      }
      if (id && id !== "*" && !id.endsWith(".*") && !other.guarantees.some((g) => g.id === id)) {
        pushRef(token, "unresolved");
        continue;
      }
      pushRef(token, "operation", other.id);
      continue;
    }
    if (DOTTED.test(token)) {
      const root = token.split(".")[0] ?? token;
      // "operation.ok.x" names a guarantee of a free function (or of a port interface).
      const segments = token.split(".");
      const prefixUnit = unitIds.get(segments[0] ?? "");
      if (prefixUnit && segments.length > 1) {
        const rest = segments.slice(1).join(".");
        if (rest === "*" || rest.endsWith(".*") || prefixUnit.guarantees.some((g) => g.id === rest)) {
          pushRef(token, "operation", prefixUnit.id);
          continue;
        }
      }
      const kind = resolveRoot(root);
      if (kind) {
        pushRef(token, kind, root);
        continue;
      }
      // `QuestEntity.determineProgressStatus` style: PascalCase root naming a program type.
      if (config.resolve.allowProgramTypes && scope.programTypeNames.has(root)) {
        pushRef(token, "type", root);
        continue;
      }
      const tail = token.split(".").pop() ?? "";
      if (entityProps.has(tail)) {
        pushRef(token, "entity", tail);
        continue;
      }
      pushRef(token, "unresolved");
      continue;
    }
    if (PASCAL.test(token) || SCREAMING.test(token)) {
      const kind = resolveRoot(token);
      if (kind) {
        pushRef(token, kind, token);
        continue;
      }
      if (unit.guarantees.some((g) => g.throws === token)) {
        pushRef(token, "type", token);
        continue;
      }
      if (config.resolve.allowProgramTypes && scope.programTypeNames.has(token)) {
        pushRef(token, "type", token);
        continue;
      }
      pushRef(token, "unresolved");
      continue;
    }
    // lowercase words are prose unless they name a parameter.
    if (/^[a-z][a-z0-9]*$/.test(token)) {
      if (paramNames.has(token)) pushRef(token, "param", token);
      continue;
    }
    // camelCase single tokens: parameters are the only thing they can legitimately name.
    if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(token)) {
      const kind = resolveRoot(token);
      if (kind) pushRef(token, kind, token);
      else if (entityProps.has(token)) pushRef(token, "entity", token);
      else pushRef(token, "unresolved");
    }
  }
  return refs;
}
