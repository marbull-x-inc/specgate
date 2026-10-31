# src/ports/order-repository.ts

_Generated (timestamp omitted)._

## OrderRepository

`interface OrderRepository`  
src/ports/order-repository.ts:16

Persistence of orders.

### Guarantees

| Id | Kind | Statement | Tests | Since |
|---|---|---|---|---|
| `ok.not-found` | ok | findById with an unknown orderId gives result = null | `tests/ports/order-repository.test.ts:5` |  |
| `ok.round-trip` | ok | after save(order), findById(order.orderId) is equal to order | `tests/ports/order-repository.test.ts:6` |  |

### Tests

- `OrderRepository.ok.not-found` (todo) — tests/ports/order-repository.test.ts:5
- `OrderRepository.ok.round-trip` (todo) — tests/ports/order-repository.test.ts:6
