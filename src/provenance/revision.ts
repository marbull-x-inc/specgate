import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The commit a checkout is on, read from the files under `.git` without running git or using the
 * network, so a report can say which revision it describes (`Report.revision`).
 *
 * @remarks
 * Follows `.git` upward from `root`, a `.git` file pointing to a worktree's git dir (and its
 * `commondir`), one `ref:` line in `HEAD`, the loose ref and `packed-refs`. Anything it cannot
 * read gives `undefined`, and the caller records nothing.
 */
export function readRevision(root: string): string | undefined {
  const gitDir = findGitDir(resolve(root));
  if (!gitDir) return undefined;
  const head = read(join(gitDir, "HEAD"))?.trim();
  if (!head) return undefined;
  if (isSha(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return undefined;
  const common = commonDir(gitDir);
  for (const dir of [gitDir, common]) {
    const loose = read(join(dir, ref))?.trim();
    if (loose && isSha(loose)) return loose;
  }
  for (const line of (read(join(common, "packed-refs")) ?? "").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha && isSha(sha)) return sha;
  }
  return undefined;
}

function findGitDir(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, ".git");
    const kind = statKind(candidate);
    if (kind === "dir") return candidate;
    if (kind === "file") {
      const target = /^gitdir:\s*(.+)$/m.exec(read(candidate) ?? "")?.[1]?.trim();
      if (!target) return undefined;
      return isAbsolute(target) ? target : resolve(dir, target);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** A worktree's git dir keeps HEAD; refs and packed-refs live in the common dir. */
function commonDir(gitDir: string): string {
  const common = read(join(gitDir, "commondir"))?.trim();
  if (!common) return gitDir;
  return isAbsolute(common) ? common : resolve(gitDir, common);
}

function statKind(path: string): "dir" | "file" | undefined {
  try {
    const s = statSync(path);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isSha(text: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(text);
}
