import { copyFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileExists } from "../util/paths.ts";
import { type Config, parseConfig } from "./schema.ts";

const CANDIDATES = [
  "specgate.config.ts",
  "specgate.config.mts",
  "specgate.config.js",
  "specgate.config.mjs",
  "specgate.config.json",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Imports the config module. Under Node a `.ts` file next to a package.json without `"type"`
 * triggers a MODULE_TYPELESS_PACKAGE_JSON warning on every run; importing a short-lived `.mts`
 * copy (unambiguously ESM, relative imports still resolve from the same directory) avoids it.
 * Bun needs no such step.
 */
async function importConfigModule(path: string): Promise<unknown> {
  const underBun = typeof process.versions["bun"] === "string";
  if (underBun || !path.endsWith(".ts")) return import(pathToFileURL(path).href);
  const temp = join(dirname(path), `.specgate.config.${process.pid}.${Date.now()}.mts`);
  copyFileSync(path, temp);
  try {
    return await import(pathToFileURL(temp).href);
  } finally {
    unlinkSync(temp);
  }
}

/**
 * Loads the repo config. A TS/JS config must export the result of `defineConfig` as default.
 *
 * @param cwd - Directory to search from, or a direct path to a config file.
 * @returns The validated config with `root` made absolute. Without a config file every default
 *   applies and `root` is `cwd`, so `check` works on an unconfigured repo.
 * @throws Error when the file exists but does not export a config object.
 */
export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<{ config: Config; path: string | undefined }> {
  const path = explicitPath
    ? resolve(cwd, explicitPath)
    : CANDIDATES.map((c) => resolve(cwd, c)).find((candidate) => fileExists(candidate));
  if (!path) {
    const config = parseConfig(undefined);
    return { config: { ...config, root: resolve(cwd, config.root) }, path: undefined };
  }
  let raw: unknown;
  if (path.endsWith(".json")) {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } else {
    const mod = await importConfigModule(path);
    raw = isRecord(mod) && "default" in mod ? mod.default : mod;
  }
  if (!isRecord(raw)) throw new Error(`specgate config at ${path} must export a config object as default`);
  const config = parseConfig(raw);
  return { config: { ...config, root: resolve(cwd, config.root) }, path };
}
