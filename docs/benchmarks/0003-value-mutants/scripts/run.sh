#!/usr/bin/env bash
# Runs one project of benchmark 0003 after both patches are applied in <work>/<project>.
#
#   scripts/run.sh <project> <work-dir> <specgate-repo>
#
# Steps (protocol, Runs): tests once; Stryker (timed); specgate static; specgate mutants (timed);
# the value-mutant runner with Stryker's coveredBy (timed, concurrency = Stryker's test runner
# count); specgate check with both reports. Outputs are copied to data/<project>/.
set -uo pipefail
project="$1"; work="$2"; repo="$3"
here="$(cd "$(dirname "$0")" && pwd)"; bench="$(dirname "$here")"
cfg="$here/config/$project"; data="$bench/data/$project"; dir="$work/$project"
read -r cwd test < <(node --input-type=module -e "const p=(await import('$here/projects.mjs')).PROJECTS['$project']; console.log(p.cwd, p.test)")
specgate=("$HOME/.bun/bin/bun" "$repo/src/cli.ts")
export CI=1 FORCE_COLOR=0
[ "$project" = cron-parser ] && export TZ=UTC
mkdir -p "$data"
cp "$cfg"/specgate*.json "$dir/"
cp "$cfg/stryker.config.json" "$dir/$cwd/"
for f in "$cfg"/vitest.stryker.config.*; do [ -e "$f" ] && cp "$f" "$dir/$cwd/"; done

echo "== tests"
(cd "$dir/$cwd" && sh -c "$test") > "$data/tests.log" 2>&1 || { echo "tests failed, see $data/tests.log"; exit 1; }

echo "== stryker"
(cd "$dir/$cwd" && /usr/bin/time -p npx stryker run stryker.config.json) > "$data/stryker.log" 2>&1
echo "stryker exit $?"
runners=$(grep -oE "Creating [0-9]+ test runner" "$data/stryker.log" | grep -oE "[0-9]+" | head -1)
runners=${runners:-1}

echo "== specgate static"
(cd "$dir" && "${specgate[@]}" check --config specgate.config.json > "$data/specgate-static.log" 2>&1)

echo "== specgate mutants"
(cd "$dir" && /usr/bin/time -p "${specgate[@]}" mutants --config specgate.config.json --out .specgate) > "$data/mutants.log" 2>&1

echo "== runner (concurrency $runners)"
(cd "$dir" && /usr/bin/time -p node "$repo/scripts/value-mutants/run.ts" --mutants .specgate/mutants.json \
  --stryker "$cwd/reports/mutation/mutation.json" --command "cd '$cwd' && $test" \
  --out reports/value/value.json --concurrency "$runners") > "$data/runner.log" 2>&1
echo "runner exit $?"

echo "== specgate with both reports"
(cd "$dir" && "${specgate[@]}" check --config specgate.mutation.config.json > "$data/specgate-mutation.log" 2>&1)

cp "$dir/.specgate-static/report.json" "$data/specgate-static.json"
cp "$dir/.specgate-mutation/report.json" "$data/specgate-mutation.json"
cp "$dir/.specgate/mutants.json" "$data/mutants.json"
cp "$dir/reports/value/value.json" "$data/value-report.json"
node "$here/summarize-mutation.mjs" "$dir/$cwd/reports/mutation/mutation.json" > "$data/mutation-summary.json"
node -e "
const fs=require('fs'); const t=f=>Number((fs.readFileSync(f,'utf8').match(/^real ([\d.]+)/m)||[])[1]);
fs.writeFileSync('$data/timings.json', JSON.stringify({strykerSeconds:t('$data/stryker.log'), mutantsSeconds:t('$data/mutants.log'), runnerSeconds:t('$data/runner.log'), runnerConcurrency:$runners}, null, 2)+'\n');
fs.writeFileSync('$data/versions.json', JSON.stringify({node:process.version, specgateCommit:require('child_process').execSync('git -C $repo rev-parse HEAD').toString().trim(), strykerCore:require('$dir/node_modules/@stryker-mutator/core/package.json').version}, null, 2)+'\n');"
echo "done: $data"
