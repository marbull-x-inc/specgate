#!/usr/bin/env node
// The value-mutant runner moved to packages/specgate-mutate/src/runner.ts. This entry point stays
// so that benchmark 0003's scripts (scripts/run.sh, scripts/regression.sh) run unchanged.
import { main } from "../../packages/specgate-mutate/src/runner.ts";

process.exitCode = await main(process.argv.slice(2));
