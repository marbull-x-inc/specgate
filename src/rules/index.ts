import { type Config, RULE_IDS, type RuleId, severityOf } from "../config/schema.ts";
import type { Finding, Report, Severity, TestCase, Unit } from "../ir/schema.ts";

/**
 * Deterministic judgement rules.
 *
 * @remarks
 * Every rule is a pure function of the extracted data (plus the previous report for change
 * detection), so the same sources always yield the same findings. Severity is configuration:
 * the rule only says what it saw. `mode: "advisory"` keeps the exit code at 0 whatever the
 * severities, which is how a repo adopts the gate before making it blocking.
 */
export interface RuleContext {
  config: Config;
  units: readonly Unit[];
  tests: readonly TestCase[];
  unlinked: ReadonlyArray<{ file: string; line: number; title: string }>;
  docMessages: ReadonlyArray<{ file: string; line: number; text: string }>;
  baseline: Report | undefined;
}

type Draft = Omit<Finding, "severity">;

function toIrSeverity(config: Config, rule: RuleId): Severity | undefined {
  const s = severityOf(config, rule);
  return s === "off" ? undefined : s;
}

export function evaluateRules(ctx: RuleContext): Finding[] {
  const drafts: Array<{ rule: RuleId; draft: Draft }> = [];
  const emit = (rule: RuleId, draft: Omit<Draft, "rule">): void => {
    drafts.push({ rule, draft: { rule, ...draft } });
  };
  const idPattern = new RegExp(ctx.config.ids.pattern);
  const placeholder = ctx.config.ids.placeholder;
  const guaranteeKeys = new Set<string>();

  for (const m of ctx.docMessages) emit("tsdoc-syntax", { message: m.text, file: m.file, line: m.line });

  for (const unit of ctx.units) {
    const real = unit.guarantees.filter((g) => g.id !== placeholder && g.id !== "");
    if (unit.guarantees.length === 0) {
      emit("operation-no-guarantee", {
        message: `${unit.id} has no guarantee (${unit.hasDoc ? "doc without @guarantee / @throws" : "no doc comment"})`,
        file: unit.file,
        line: unit.line,
        unit: unit.id,
      });
    } else if (real.length === 0) {
      emit("guarantee-placeholder", {
        message: `${unit.id} has only placeholder guarantees`,
        file: unit.file,
        line: unit.line,
        unit: unit.id,
      });
    }
    const seenIds = new Map<string, number>();
    for (const g of unit.guarantees) {
      if (g.id === placeholder) {
        emit("guarantee-placeholder", {
          message: `${unit.id}: @${g.source} ${placeholder} is still a placeholder`,
          file: unit.file,
          line: g.line,
          unit: unit.id,
        });
        continue;
      }
      if (g.id === "" || !idPattern.test(g.id)) {
        emit("guarantee-id-invalid", {
          message: `${unit.id}: @${g.source} id "${g.id}" does not match ${ctx.config.ids.pattern}`,
          file: unit.file,
          line: g.line,
          unit: unit.id,
          guarantee: g.key,
        });
        continue;
      }
      seenIds.set(g.id, (seenIds.get(g.id) ?? 0) + 1);
      guaranteeKeys.add(g.key);
      if (g.tests.length === 0) {
        emit("guarantee-no-test", {
          message: `${g.key} has no test naming it`,
          file: unit.file,
          line: g.line,
          unit: unit.id,
          guarantee: g.key,
        });
      }
      for (const ref of g.references) {
        if (ref.kind === "unresolved") {
          emit("identifier-unresolved", {
            message: `${g.key}: "${ref.raw}" is not a parameter, declared port, entity or public operation`,
            file: unit.file,
            line: g.line,
            unit: unit.id,
            guarantee: g.key,
          });
        }
      }
    }
    for (const [id, count] of seenIds) {
      if (count > 1)
        emit("guarantee-id-duplicate", {
          message: `${unit.id}: id "${id}" is declared ${count} times`,
          file: unit.file,
          line: unit.line,
          unit: unit.id,
        });
    }
    if (unit.kind === "method" && unit.guarantees.length > 0) {
      const memberToType = new Map(unit.injectedPorts.map((p) => [p.member, p.type] as const));
      const declared = new Set([...unit.uses, ...unit.modifies].filter((p) => p !== placeholder));
      const actual = new Set(unit.portCalls.map((c) => memberToType.get(c.port) ?? c.port));
      const undeclared = [...actual].filter((t) => !declared.has(t) && !declared.has(stripInterfacePrefix(t)));
      const unused = [...declared].filter((d) => ![...actual].some((a) => a === d || stripInterfacePrefix(a) === d));
      if (undeclared.length > 0)
        emit("uses-mismatch", {
          message: `${unit.id} calls ports not declared in @uses/@modifies: ${undeclared.join(", ")}`,
          file: unit.file,
          line: unit.line,
          unit: unit.id,
        });
      if (unused.length > 0)
        emit("uses-mismatch", {
          message: `${unit.id} declares ports it never calls: ${unused.join(", ")}`,
          file: unit.file,
          line: unit.line,
          unit: unit.id,
        });
    }
    for (const env of unit.envInputs) {
      emit("env-input-direct", {
        message: `${unit.id} reads an environment input directly (${env.expression}); route it through a port`,
        file: unit.file,
        line: env.line,
        unit: unit.id,
      });
    }
  }

  for (const t of ctx.tests) {
    if (!guaranteeKeys.has(t.key)) {
      emit("test-orphan", {
        message: `test names "${t.key}" but no guarantee with that key exists`,
        file: t.file,
        line: t.line,
        test: t.key,
        ...(t.unitId ? { unit: t.unitId } : {}),
      });
    } else if (t.status === "todo") {
      emit("test-todo", {
        message: `${t.key} is still test.todo`,
        file: t.file,
        line: t.line,
        test: t.key,
        ...(t.unitId ? { unit: t.unitId } : {}),
      });
    }
  }

  if (ctx.baseline) evaluateAgainstBaseline(ctx, ctx.baseline, emit);

  const findings: Finding[] = [];
  for (const { rule, draft } of drafts) {
    const severity = toIrSeverity(ctx.config, rule);
    if (severity) findings.push({ ...draft, severity });
  }
  const order: Record<Severity, number> = { fail: 0, warn: 1, info: 2 };
  return findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

function stripInterfacePrefix(name: string): string {
  return /^I[A-Z]/.test(name) ? name.slice(1) : name;
}

function evaluateAgainstBaseline(
  ctx: RuleContext,
  baseline: Report,
  emit: (rule: RuleId, draft: Omit<Draft, "rule">) => void,
): void {
  const baseTests = new Map(baseline.tests.map((t) => [`${t.key}@${t.file}`, t] as const));
  const currentTests = new Map(ctx.tests.map((t) => [`${t.key}@${t.file}`, t] as const));
  const testsUnchanged = (key: string): boolean => {
    const current = ctx.tests.filter((t) => t.key === key);
    if (current.length === 0) return true;
    return current.every((t) => {
      const before = baseTests.get(`${t.key}@${t.file}`);
      return before !== undefined && before.bodyHash === t.bodyHash;
    });
  };
  void currentTests;
  const currentIds = new Set(ctx.units.map((u) => u.id));
  const superseded = new Set(ctx.units.map((u) => u.supersedes).filter((s): s is string => s !== undefined));

  for (const baseUnit of baseline.units) {
    const unit = ctx.units.find((u) => u.id === baseUnit.id);
    if (!unit) {
      if (!currentIds.has(baseUnit.id) && !superseded.has(baseUnit.id)) {
        emit("operation-removed", {
          message: `${baseUnit.id} disappeared from the public surface without @supersedes`,
          file: baseUnit.file,
          line: baseUnit.line,
          unit: baseUnit.id,
        });
      }
      continue;
    }
    let anyGuaranteeChanged = false;
    for (const baseG of baseUnit.guarantees) {
      const g = unit.guarantees.find((x) => x.key === baseG.key);
      if (!g) continue;
      if (g.textHash !== baseG.textHash) {
        anyGuaranteeChanged = true;
        if (testsUnchanged(g.key) && g.tests.length > 0) {
          emit("guarantee-changed-test-unchanged", {
            message: `${g.key} text changed but none of its tests changed`,
            file: unit.file,
            line: g.line,
            unit: unit.id,
            guarantee: g.key,
          });
        }
      }
    }
    const anyTestChanged = unit.guarantees.some((g) => !testsUnchanged(g.key));
    if (unit.implHash !== baseUnit.implHash && !anyGuaranteeChanged && !anyTestChanged && unit.guarantees.length > 0) {
      emit("impl-changed-spec-unchanged", {
        message: `${unit.id} implementation changed but neither guarantees nor tests did`,
        file: unit.file,
        line: unit.line,
        unit: unit.id,
      });
    }
  }
}

export const ALL_RULES: readonly RuleId[] = RULE_IDS;
