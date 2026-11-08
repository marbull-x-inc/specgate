import { RULE_IDS } from "../config/schema.ts";
import type { AcceptTag, Finding, Severity, Unit } from "../ir/schema.ts";

/**
 * `@acceptFinding <rule-id> <target> <reason>` on a unit: one finding accepted next to the code,
 * with the reason a reviewer reads in the diff.
 *
 * @remarks
 * The accepted-findings file accepts by fingerprint, without a reason, and is rewritten
 * wholesale; `decisions.ignore` matches a value across the whole repository. A tag is scoped to
 * one unit and one rule. Its target is the value the finding quotes (`"iss"` or `iss` for
 * `match "iss"`), `Mutator` or `Mutator:"replacement"` for a `mutant-survived` or
 * `mutant-contradicts-guarantee` finding, or `*`
 * for every finding of the rule on the unit. A matching finding becomes `info` with
 * `accepted: true` and `acceptedReason`. A tag that names an unknown rule or gives no target or
 * reason is `accept-tag-invalid`; a valid tag no finding matches any more is `accept-tag-unused`,
 * so acceptances do not outlive what they accepted.
 */
export function applyAcceptTags(
  units: readonly Unit[],
  findings: readonly Finding[],
  severityOf: (rule: "accept-tag-invalid" | "accept-tag-unused") => Severity | undefined,
): Finding[] {
  const out = [...findings];
  const extra: Finding[] = [];
  const known = new Set<string>(RULE_IDS);
  for (const unit of units) {
    for (const tag of unit.accepts ?? []) {
      const problem = !known.has(tag.rule)
        ? `names no rule specgate has ("${tag.rule}")`
        : tag.target === ""
          ? "gives no value to accept"
          : tag.reason === ""
            ? "gives no reason"
            : undefined;
      if (problem) {
        const severity = severityOf("accept-tag-invalid");
        if (severity)
          extra.push({
            rule: "accept-tag-invalid",
            severity,
            message: `@acceptFinding on ${unit.id} ${problem}; write @acceptFinding <rule-id> <value> <reason>`,
            file: unit.file,
            line: tag.line,
            unit: unit.id,
          });
        continue;
      }
      let used = false;
      out.forEach((f, i) => {
        if (f.unit !== unit.id || !ruleMatches(tag.rule, f.rule) || !targets(tag, f)) return;
        used = true;
        out[i] = { ...f, severity: "info", accepted: true, acceptedReason: tag.reason };
      });
      if (!used) {
        const severity = severityOf("accept-tag-unused");
        if (severity)
          extra.push({
            rule: "accept-tag-unused",
            severity,
            message: `@acceptFinding ${tag.rule} ${tag.target} on ${unit.id} matches no finding any more; remove it`,
            file: unit.file,
            line: tag.line,
            unit: unit.id,
          });
      }
    }
  }
  return [...out, ...extra];
}

function unquoted(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/**
 * A `mutant-survived` tag also accepts the mutant when it is reported as
 * `mutant-contradicts-guarantee` (#62): both rules are about the same surviving mutant, and a tag
 * written before the split keeps working.
 */
function ruleMatches(tagRule: string, findingRule: string): boolean {
  return tagRule === findingRule || (tagRule === "mutant-survived" && findingRule === "mutant-contradicts-guarantee");
}

function targets(tag: AcceptTag, f: Finding): boolean {
  if (tag.target === "*") return true;
  if (tag.rule === "mutant-survived" || tag.rule === "mutant-contradicts-guarantee") {
    if (!f.mutant) return false;
    const colon = tag.target.indexOf(":");
    const mutator = colon < 0 ? tag.target : tag.target.slice(0, colon);
    if (f.mutant.mutator !== mutator) return false;
    return colon < 0 || f.mutant.replacement === unquoted(tag.target.slice(colon + 1));
  }
  return f.message.includes(JSON.stringify(unquoted(tag.target)));
}
