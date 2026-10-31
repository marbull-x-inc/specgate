#!/usr/bin/env node
// Entry point for the published package. `dist/` is emitted by `bun run build` (tsc).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { main } = await import(pathToFileURL(join(here, "..", "dist", "cli.js")).href);
process.exitCode = await main(process.argv.slice(2));
