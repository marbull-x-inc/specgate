import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function relativeTo(root: string, file: string): string {
  return toPosix(relative(root, file));
}

export function absoluteFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/** Translates one glob into a regular expression (`**`, `*`, `?`, `{a,b}`; no brace nesting). */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  const p = pattern.replace(/^\.\//, "");
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] ?? "";
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const slashAfter = p[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const close = p.indexOf("}", i);
      if (close < 0) {
        out += "\\{";
      } else {
        const alternatives = p
          .slice(i + 1, close)
          .split(",")
          .map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&"));
        out += `(?:${alternatives.join("|")})`;
        i = close;
      }
    } else if (/[.+^$()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * Expands include globs under `root`, dropping matches of the exclude globs and anything under
 * node_modules. Uses the platform `glob` from `node:fs` (Node 22+ and Bun) so that no
 * third-party matcher is needed; results are absolute, POSIX-sorted and unique.
 */
export async function expandGlobs(root: string, include: string[], exclude: string[] = []): Promise<string[]> {
  const excluded = [...exclude, "**/node_modules/**"].map(globToRegExp);
  const out = new Set<string>();
  for (const pattern of include) {
    for await (const match of glob(pattern, { cwd: root })) {
      const rel = toPosix(match);
      if (excluded.some((re) => re.test(rel))) continue;
      const abs = resolve(root, match);
      if (existsSync(abs)) out.add(abs);
    }
  }
  return [...out].sort();
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
