import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config/schema.ts";

/**
 * The package's entries (`package.json#exports` subpaths) and the source module each one's
 * guarantees are written in.
 *
 * @remarks
 * A subpath maps to a source module through `surface.entries`, or else through an export
 * condition whose target is a TypeScript source file under `root` (the `bun` / `source` /
 * `development` conditions many packages already publish). Subpaths whose targets are only
 * build output are returned as unmapped, so `entry-unmapped` can say how to map them; subpaths
 * that export no JavaScript (`./package.json`, `./tsdoc.json`) and wildcard subpaths are skipped.
 */
export interface PackageEntry {
  subpath: string;
  /** Absolute path of the source module, when mapped */
  source: string | undefined;
  /** Condition path (`import.default`, `bun`) → target, as written */
  conditions: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flattens nested conditions into `a.b` → target. */
function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (typeof value === "string") {
    out[prefix || "default"] = value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      flatten(v, prefix ? `${prefix}.${i}` : String(i), out);
    });
    return;
  }
  if (isRecord(value)) for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
}

function subpathMap(exportsField: unknown): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  if (exportsField === undefined) return map;
  const keys = isRecord(exportsField) ? Object.keys(exportsField) : [];
  // `"exports": "./x.js"` or `"exports": { "import": …, "require": … }` describe the "." entry.
  if (!isRecord(exportsField) || keys.every((k) => !k.startsWith("."))) {
    const out: Record<string, string> = {};
    flatten(exportsField, "", out);
    map.set(".", out);
    return map;
  }
  for (const [subpath, target] of Object.entries(exportsField)) {
    const out: Record<string, string> = {};
    flatten(target, "", out);
    map.set(subpath, out);
  }
  return map;
}

const SOURCE_FILE = /\.(?:[mc]?ts|tsx)$/;
const JS_TARGET = /\.(?:[mc]?[jt]s|tsx|jsx)$/;

export function packageEntries(config: Config): PackageEntry[] {
  const pkgPath = resolve(config.root, "package.json");
  if (!existsSync(pkgPath)) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(pkg)) return [];
  const map = subpathMap(pkg["exports"]);
  if (map.size === 0 && typeof pkg["main"] === "string") map.set(".", { default: pkg["main"] });
  const out: PackageEntry[] = [];
  for (const [subpath, conditions] of map) {
    if (subpath.includes("*")) continue;
    const targets = Object.values(conditions);
    if (!targets.some((t) => JS_TARGET.test(t) && !t.endsWith(".d.ts"))) continue;
    const configured = config.surface.entries[subpath];
    const fromCondition = targets.find((t) => SOURCE_FILE.test(t) && !/\.d\.[mc]?ts$/.test(t));
    const candidate = configured ?? fromCondition;
    const abs = candidate ? resolve(config.root, candidate) : undefined;
    out.push({ subpath, source: abs && existsSync(abs) ? abs : undefined, conditions });
  }
  return out;
}

/** `entry#main` for ".", else the subpath with `/`, `.` and `-` turned into `_`: `./presets/ddd-ts` → `entry#presets_ddd_ts`. */
export function entryUnitId(subpath: string): string {
  if (subpath === ".") return "entry#main";
  const slug = subpath
    .replace(/^\.\//, "")
    .replace(/[^A-Za-z0-9_$]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `entry#${slug || "main"}`;
}
