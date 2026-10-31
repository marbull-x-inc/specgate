#!/usr/bin/env node
import { dirname, join } from "node:path";
// Entry point. Bun executes TypeScript directly; under Node the user runs `bun run specgate` or compiles first.
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { main } = await import(pathToFileURL(join(here, "..", "src", "cli.ts")).href);
process.exitCode = await main(process.argv.slice(2));
