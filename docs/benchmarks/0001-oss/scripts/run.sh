#!/usr/bin/env bash
# Reproduces one project of benchmark 0001 end to end.
#
#   scripts/run.sh <project> <work-dir>
#
# Clones the project at the pinned commit into <work-dir>/<project>, applies the guarantee and
# link patches, installs dependencies (lifecycle scripts off), installs specgate 0.5.0 and
# Stryker, runs the tests, Stryker (timed) and specgate (static x3 timed, then with the report),
# and copies the outputs to data/<project>/.
set -euo pipefail

project="$1"
work="$2"
here="$(cd "$(dirname "$0")" && pwd)"
bench="$(dirname "$here")"
cfg="$here/config/$project"
data="$bench/data/$project"

repo=""; sha=""; pm="pnpm"; runner="vitest"; strykerVersion="10.1.1"; strykerCwd="."; testCmd=""
case "$project" in
  ms)            repo=vercel/ms;           sha=4ff48cec099f0514c3e9bbca18706c9c21122bfb; runner=jest;   testCmd="npx jest --env node" ;;
  scule)         repo=unjs/scule;          sha=5bc68048caad7c0e7de35842c83a510e8e1a7c4f; testCmd="npx vitest run" ;;
  ufo)           repo=unjs/ufo;            sha=f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6; testCmd="npx vitest run" ;;
  zustand)       repo=pmndrs/zustand;      sha=382d29c485e67018c06e75ec7235130d0968522c; testCmd="npx vitest run" ;;
  mantine-hooks) repo=mantinedev/mantine;  sha=82fb128c43f9927c1370a2732cd5aa9e6663ca11; pm=yarn; runner=jest; testCmd="npx jest packages/@mantine/hooks" ;;
  ahooks)        repo=alibaba/hooks;       sha=a0c33c21caefda40753fe4b3cbb3b1efbabd1a79; strykerCwd=packages/hooks; testCmd="npx vitest run" ;;
  hono)          repo=honojs/hono;         sha=eb754bd5ef22c63f1634a4c374a86be086f85710; testCmd="npx vitest run --config vitest.stryker.config.ts" ;;
  *) echo "unknown project $project" >&2; exit 2 ;;
esac
# Projects whose vitest is older than the runner's peer range use an older Stryker (see report).
[ -f "$cfg/stryker.version" ] && strykerVersion="$(cat "$cfg/stryker.version")"

dir="$work/$project"
if [ ! -d "$dir/.git" ]; then
  git init -q "$dir"
  git -C "$dir" remote add origin "https://github.com/$repo.git"
  git -C "$dir" fetch -q --depth 1 origin "$sha"
  git -C "$dir" checkout -q FETCH_HEAD
fi
cd "$dir"
git apply "$bench/patches/$project-guarantees.patch"
git apply "$bench/patches/$project-links.patch"
cp "$cfg"/specgate*.json .
[ -f "$cfg/vitest.stryker.config.ts" ] && cp "$cfg/vitest.stryker.config.ts" .
cp "$cfg/stryker.config.json" "$strykerCwd/"

export CI=1 HUSKY=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
pkgs=("@marbull-x-inc/specgate@0.5.0" "@stryker-mutator/core@$strykerVersion" "@stryker-mutator/$runner-runner@$strykerVersion")
if [ "$pm" = yarn ]; then
  YARN_ENABLE_SCRIPTS=0 corepack yarn install --immutable --mode=skip-build
  YARN_ENABLE_SCRIPTS=0 YARN_ENABLE_IMMUTABLE_INSTALLS=0 corepack yarn add -D "${pkgs[@]}"
else
  # hono declares pnpm 12; use PNPM=<path to pnpm 12> for it.
  ${PNPM:-corepack pnpm} install --frozen-lockfile --ignore-scripts
  ${PNPM:-corepack pnpm} add -D -w --ignore-scripts "${pkgs[@]}" 2>/dev/null \
    || ${PNPM:-corepack pnpm} add -D --ignore-scripts "${pkgs[@]}"
fi
tools="$dir"
specgate="$dir/node_modules/.bin/specgate"
stryker="$dir/node_modules/.bin/stryker"
mkdir -p "$data"

echo "== tests"
(cd "$dir" && $testCmd) > "$data/tests.log" 2>&1 || { echo "tests failed, see $data/tests.log"; exit 1; }

echo "== stryker"
start=$(date +%s)
(cd "$strykerCwd" && "$stryker" run stryker.config.json) > "$data/stryker.log" 2>&1
end=$(date +%s)

echo "== specgate static (3 runs)"
times=()
for _ in 1 2 3; do
  s=$(node -e 'console.log(performance.timeOrigin + performance.now())')
  "$specgate" check --config specgate.config.json > /dev/null
  e=$(node -e 'console.log(performance.timeOrigin + performance.now())')
  times+=("$(node -e "console.log(($e - $s) / 1000)")")
done
echo "== specgate with mutation report"
"$specgate" check --config specgate.mutation.config.json > /dev/null

cp .specgate-static/report.json "$data/specgate-static.json"
cp .specgate-mutation/report.json "$data/specgate-mutation.json"
node "$here/summarize-mutation.mjs" "$strykerCwd/reports/mutation/mutation.json" > "$data/mutation-summary.json"
node -e "
const fs=require('fs');
fs.writeFileSync('$data/timings.json', JSON.stringify({
  strykerSeconds: $end - $start,
  specgateStaticSeconds: [${times[*]}].map(Number).sort((a,b)=>a-b),
}, null, 2) + '\n');
fs.writeFileSync('$data/versions.json', JSON.stringify({
  commit: '$sha',
  node: process.version,
  specgate: require('$tools/node_modules/@marbull-x-inc/specgate/package.json').version,
  strykerCore: require('$tools/node_modules/@stryker-mutator/core/package.json').version,
  strykerRunner: require('$tools/node_modules/@stryker-mutator/$runner-runner/package.json').version,
}, null, 2) + '\n');
"
echo "done: $data"
