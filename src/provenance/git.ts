import { spawnSync } from "node:child_process";
import type { Config } from "../config/schema.ts";
import type { ProvenanceCommit, Unit } from "../ir/schema.ts";

/**
 * Records, per guarantee, the commit that introduced it and the one that last changed it.
 *
 * @remarks
 * This is how requirements are linked without writing tracker ids into code: the pull request
 * that introduced a guarantee names the ticket, and the tool only records the commit and the
 * PR number parsed from the squash-merge subject. Whoever consumes the IR joins PR → ticket →
 * frozen requirement with their own rule, so a tracker migration touches that rule, not the
 * sources. Everything here degrades to `undefined` outside a git checkout.
 */
function git(root: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return undefined;
  return result.stdout;
}

export function isGitRepository(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

interface BlameLine {
  commit: string;
  authorTime: number;
  summary: string;
}

function parseBlame(porcelain: string): Map<number, BlameLine> {
  const lines = porcelain.split("\n");
  const out = new Map<number, BlameLine>();
  const commits = new Map<string, Partial<BlameLine>>();
  let current: string | undefined;
  let currentLine: number | undefined;
  for (const line of lines) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      current = header[1];
      currentLine = Number(header[2]);
      if (current && !commits.has(current)) commits.set(current, { commit: current });
      continue;
    }
    if (!current) continue;
    const info = commits.get(current);
    if (!info) continue;
    if (line.startsWith("author-time ")) info.authorTime = Number(line.slice("author-time ".length));
    else if (line.startsWith("summary ")) info.summary = line.slice("summary ".length);
    else if (line.startsWith("\t") && currentLine !== undefined) {
      out.set(currentLine, { commit: current, authorTime: info.authorTime ?? 0, summary: info.summary ?? "" });
    }
  }
  return out;
}

function toCommit(line: BlameLine | undefined, prPattern: RegExp): ProvenanceCommit | undefined {
  if (!line || /^0{40}$/.test(line.commit)) return undefined;
  const pr = prPattern.exec(line.summary)?.[1];
  return { commit: line.commit, date: new Date(line.authorTime * 1000).toISOString(), ...(pr ? { pr } : {}) };
}

function introducedCommit(root: string, file: string, needle: string, prPattern: RegExp): ProvenanceCommit | undefined {
  const out = git(root, ["log", "--reverse", "--format=%H%x1f%at%x1f%s", `-S${needle}`, "--", file]);
  const first = out?.split("\n").find((l) => l.length > 0);
  if (!first) return undefined;
  const [commit, at, summary] = first.split("\x1f");
  if (!commit || !at) return undefined;
  return toCommit({ commit, authorTime: Number(at), summary: summary ?? "" }, prPattern);
}

/** Fills `guarantee.provenance` in place for every unit. */
export function attachProvenance(config: Config, units: Unit[]): void {
  if (!config.provenance.enabled || !isGitRepository(config.root)) return;
  const prPattern = new RegExp(config.provenance.prPattern);
  const blameCache = new Map<string, Map<number, BlameLine>>();
  for (const unit of units) {
    if (unit.guarantees.length === 0) continue;
    let blame = blameCache.get(unit.file);
    if (!blame) {
      const porcelain = git(config.root, ["blame", "--porcelain", "--", unit.file]);
      blame = porcelain ? parseBlame(porcelain) : new Map();
      blameCache.set(unit.file, blame);
    }
    for (const g of unit.guarantees) {
      if (!g.id) continue;
      const lastChanged = toCommit(blame.get(g.line), prPattern);
      const introduced = lastChanged ? introducedCommit(config.root, unit.file, `${g.id} `, prPattern) : undefined;
      if (lastChanged || introduced) {
        g.provenance = { ...(introduced ? { introduced } : {}), ...(lastChanged ? { lastChanged } : {}) };
      }
    }
  }
}
