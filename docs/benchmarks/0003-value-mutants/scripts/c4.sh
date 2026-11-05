#!/usr/bin/env bash
# C4: static decision-* findings on benchmark 0001's six projects, this branch against 0.5.0.
#
#   scripts/c4.sh <work-dir-0001> <specgate-repo>
#
# Each project is cloned at 0001's pin with 0001's guarantee and link patches applied and its
# dependencies installed as 0001's run.sh does. specgate runs from <specgate-repo> with 0001's
# specgate.config.json; 0.5.0's findings come from 0001's committed data/<project>/specgate-static.json
# (branch feature/bench-oss-0001-e87ac9). Writes data/c4/<project>.json and prints a table.
set -uo pipefail
work="$1"; repo="$2"
here="$(cd "$(dirname "$0")" && pwd)"; out="$(dirname "$here")/data/c4"
branch=feature/bench-oss-0001-e87ac9
mkdir -p "$out"
for p in scule ufo zustand mantine-hooks ahooks hono; do
  dir="$work/$p"
  git -C "$repo" show "$branch:docs/benchmarks/0001-oss/scripts/config/$p/specgate.config.json" > "$dir/specgate.0001.config.json"
  (cd "$dir" && "$HOME/.bun/bin/bun" "$repo/src/cli.ts" check --config specgate.0001.config.json --no-provenance --out .specgate-c4 > /dev/null 2>&1)
  git -C "$repo" show "$branch:docs/benchmarks/0001-oss/data/$p/specgate-static.json" > "$out/$p-0.5.0.json"
  cp "$dir/.specgate-c4/report.json" "$out/$p-branch.json"
  node -e "
    const count = (f) => { const r = require(f); const c = {}; for (const x of r.findings) if (x.rule.startsWith('decision-')) c[x.rule] = (c[x.rule] ?? 0) + 1; return c; };
    const a = count('$out/$p-0.5.0.json'), b = count('$out/$p-branch.json');
    const rules = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const total = (c) => Object.values(c).reduce((n, v) => n + v, 0);
    console.log('$p', JSON.stringify({ '0.5.0': total(a), branch: total(b), byRule: Object.fromEntries(rules.map((r) => [r, [a[r] ?? 0, b[r] ?? 0]])) }));
  "
done
