import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileExists } from "../util/paths.ts";
import { type Config, zConfig } from "./schema.ts";

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
    const config = zConfig.parse({});
    return { config: { ...config, root: resolve(cwd, config.root) }, path: undefined };
  }
  let raw: unknown;
  if (path.endsWith(".json")) {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } else {
    const mod: unknown = await import(pathToFileURL(path).href);
    raw = isRecord(mod) && "default" in mod ? mod.default : mod;
  }
  if (!isRecord(raw)) throw new Error(`specgate config at ${path} must export a config object as default`);
  const config = zConfig.parse(raw);
  return { config: { ...config, root: resolve(cwd, config.root) }, path };
}
