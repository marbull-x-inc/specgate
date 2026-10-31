import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A scratch directory inside the package so that `zod` and `specgate/*` resolve from node_modules. */
export function workDir(prefix: string): string {
  const base = join(PACKAGE_ROOT, "tests", "fixtures", ".work");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}
