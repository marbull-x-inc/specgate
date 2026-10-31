# src/domain/money.ts

_Generated (timestamp omitted)._

## addMoney

`addMoney(a: Money, b: Money): Money`  
src/domain/money.ts:29

Adds two amounts of the same currency.

### Why

Mixing currencies is a programming error, not user input, so it throws instead of returning a result type.

### Parameters

| Name | Type | Constraint |
|---|---|---|
| `a` | `Money` | first operand |
| `b` | `Money` | second operand, must share `a.currency` |

### Guarantees

| Id | Kind | Statement | Tests | Since |
|---|---|---|---|---|
| `ok.sum` | ok | result.amount = a.amount + b.amount and result.currency = a.currency | `tests/domain/money.test.ts:5` |  |
| `ok.pure` | ok | a and b are unchanged after the call | `tests/domain/money.test.ts:24` |  |
| `err.currency-mismatch` | err | throws `RangeError` — a.currency differs from b.currency | `tests/domain/money.test.ts:11` |  |

### Examples

```ts
addMoney({ amount: 1, currency: "JPY" }, { amount: 2, currency: "JPY" }) // => { amount: 3, currency: "JPY" }
```

### How it runs (extracted from the implementation)

_Calls no ports._

Referenced by: `src/application/place-order.ts`, `src/main.ts`

### Tests

- `addMoney.ok.sum` — tests/domain/money.test.ts:5
- `addMoney.err.currency-mismatch` — tests/domain/money.test.ts:11
- `addMoney.ok.nonexistent` — tests/domain/money.test.ts:14
- `addMoney.ok.pure` (todo) — tests/domain/money.test.ts:24
