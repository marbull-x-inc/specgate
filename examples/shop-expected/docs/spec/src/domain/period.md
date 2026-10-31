# src/domain/period.ts

_Generated (timestamp omitted)._

## isWithinPeriod

`isWithinPeriod(period: Period | null, clock: Clock): boolean`  
src/domain/period.ts:24

Tells whether the clock's current time falls inside the period.

### Why

Both ends are inclusive so that an action at exactly `end` still counts.

### Parameters

| Name | Type | Constraint |
|---|---|---|
| `period` | `Period \| null` |  |
| `clock` | `Clock` |  |

### Guarantees

| Id | Kind | Statement | Tests | Since |
|---|---|---|---|---|
| `ok.within` | ok | Clock.now ∈ [period.start, period.end] gives result = true | `tests/domain/period.test.ts:9` |  |
| `ok.outside` | ok | Clock.now outside the interval gives result = false | `tests/domain/period.test.ts:10` |  |
| `ok.unbounded` | ok | period = null (no limit) gives result = true | `tests/domain/period.test.ts:11` |  |

### Examples

```ts
isWithinPeriod(null, { now: () => new Date(0) }) // => true
```

### How it runs (extracted from the implementation)

| Port | Member | Calls | Declared |
|---|---|---|---|
| `clock` | `now` | 1 | **undeclared** |

Referenced by: `src/main.ts`

### Tests

- `isWithinPeriod.ok.within` (todo) — tests/domain/period.test.ts:9
- `isWithinPeriod.ok.outside` (todo) — tests/domain/period.test.ts:10
- `isWithinPeriod.ok.unbounded` (todo) — tests/domain/period.test.ts:11
