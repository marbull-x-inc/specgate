#!/usr/bin/env bash
# Regression check on benchmark 0001's six projects (protocol, Runs): Stryker with 0001's config,
# specgate mutants, the runner and specgate check with both reports. Counts only.
#
#   scripts/regression.sh <work-dir-0001> <specgate-repo> [project…]
set -uo pipefail
work="$1"; repo="$2"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"; out="$(dirname "$here")/data/regression"
branch=feature/bench-oss-0001-e87ac9
specgate=("$HOME/.bun/bin/bun" "$repo/src/cli.ts")
export CI=1 FORCE_COLOR=0
for p in "${@:-scule ufo zustand mantine-hooks ahooks hono}"; do
  cwd=.; test="npx vitest run"
  case "$p" in
    mantine-hooks) test="npx jest --watchman=false packages/@mantine/hooks" ;;
    ahooks) cwd=packages/hooks ;;
    hono) test="npx vitest run --config vitest.stryker.config.ts" ;;
  esac
  dir="$work/$p"; data="$out/$p"; mkdir -p "$data"
  echo "### $p $(date +%T)"
  git -C "$repo" show "$branch:docs/benchmarks/0001-oss/scripts/config/$p/stryker.config.json" > "$dir/$cwd/stryker.config.json"
  [ "$p" = hono ] && git -C "$repo" show "$branch:docs/benchmarks/0001-oss/scripts/config/hono/vitest.stryker.config.ts" > "$dir/vitest.stryker.config.ts"
  [ "$p" = mantine-hooks ] && node -e "const f='$dir/stryker.config.json'; const c=require(f); c.jest.config={...c.jest.config, watchman:false}; require('fs').writeFileSync(f, JSON.stringify(c,null,2));"
  git -C "$repo" show "$branch:docs/benchmarks/0001-oss/scripts/config/$p/specgate.config.json" > "$dir/specgate.0001.config.json"
  node -e "
    const c = require('$dir/specgate.0001.config.json');
    c.output = { dir: '.specgate-regression' };
    c.mutation = { report: ['$cwd/reports/mutation/mutation.json'.replace(/^\.\//, ''), 'reports/value/value.json'] };
    require('fs').writeFileSync('$dir/specgate.regression.config.json', JSON.stringify(c, null, 2));"
  (cd "$dir/$cwd" && /usr/bin/time -p npx stryker run stryker.config.json) > "$data/stryker.log" 2>&1 < /dev/null
  echo "stryker exit $?"
  runners=$(grep -oE "Creating [0-9]+ test runner" "$data/stryker.log" | grep -oE "[0-9]+" | head -1)
  (cd "$dir" && /usr/bin/time -p "${specgate[@]}" mutants --config specgate.0001.config.json --out .specgate) > "$data/mutants.log" 2>&1
  (cd "$dir" && /usr/bin/time -p node "$repo/scripts/value-mutants/run.ts" --mutants .specgate/mutants.json \
    --stryker "$cwd/reports/mutation/mutation.json" --command "cd '$cwd' && $test" \
    --out reports/value/value.json --concurrency "${runners:-1}") > "$data/runner.log" 2>&1 < /dev/null
  echo "runner exit $?"
  (cd "$dir" && "${specgate[@]}" check --config specgate.regression.config.json --no-provenance > "$data/check.log" 2>&1)
  cp "$dir/.specgate/mutants.json" "$data/mutants.json" 2>/dev/null
  cp "$dir/reports/value/value.json" "$data/value-report.json" 2>/dev/null
  node "$here/summarize-mutation.mjs" "$dir/$cwd/reports/mutation/mutation.json" > "$data/mutation-summary.json" 2>/dev/null
  echo "done $p"
done
