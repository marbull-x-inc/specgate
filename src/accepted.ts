import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config/schema.ts";
import type { Finding } from "./ir/schema.ts";

/**
 * Accepted findings: the findings a repository had when it adopted specgate, recorded so that
 * later runs fail only on what is new.
 *
 * @remarks
 * A finding is identified by its rule, file, unit, guarantee, test and message, never by its
 * line, so moving code does not resurrect it; changing what it says (a new statement, another
 * test) does. Accepted findings stay in the report as `info` with `accepted: true`, so the debt
 * remains visible. The file (`output.accepted`, default `specgate.accepted.json`) is meant to be
 * committed and shrinks as findings are fixed: `check --accept-baseline` rewrites it from the
 * current findings.
 */
export interface AcceptedFile {
  version: 1;
  findings: string[];
}

export function fingerprint(f: Finding): string {
  // Line numbers inside messages (file:line) would make the fingerprint move with the code.
  const message = f.message.replace(/:\d+\b/g, "");
  return [f.rule, f.file ?? "", f.unit ?? "", f.guarantee ?? "", f.test ?? "", message].join("|");
}

function acceptedPath(config: Config): string {
  return resolve(config.root, config.output.accepted);
}

function isAcceptedFile(value: unknown): value is AcceptedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "findings" in value &&
    Array.isArray(value.findings) &&
    value.findings.every((f: unknown) => typeof f === "string")
  );
}

export function readAccepted(config: Config): Set<string> {
  const path = acceptedPath(config);
  if (!existsSync(path)) return new Set();
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isAcceptedFile(parsed)) throw new Error(`${path} is not a specgate accepted-findings file`);
  return new Set(parsed.findings);
}

/** Marks findings recorded as accepted: severity `info`, `accepted: true`. */
export function applyAccepted(findings: readonly Finding[], accepted: ReadonlySet<string>): Finding[] {
  if (accepted.size === 0) return [...findings];
  return findings.map((f) =>
    f.severity !== "info" && accepted.has(fingerprint(f)) ? { ...f, severity: "info", accepted: true } : f,
  );
}

/**
 * Records every current `fail` / `warn` finding (including already accepted ones that still
 * occur) as accepted. Findings that no longer occur drop out of the file.
 * @returns The path written and the number of findings recorded.
 */
export function writeAccepted(config: Config, findings: readonly Finding[]): { path: string; count: number } {
  const keep = [
    ...new Set(
      findings
        // A finding accepted by an @acceptFinding tag stays accepted in the source, not in the file.
        .filter((f) => f.acceptedReason === undefined && (f.severity !== "info" || f.accepted === true))
        .map(fingerprint),
    ),
  ].sort();
  const path = acceptedPath(config);
  const file: AcceptedFile = { version: 1, findings: keep };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return { path, count: keep.length };
}
