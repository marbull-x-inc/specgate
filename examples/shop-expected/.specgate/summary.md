## specgate check (advisory)

| Units | Without guarantee | Guarantees | Without test | Tests | Orphan tests | Unlinked tests |
|---:|---:|---:|---:|---:|---:|---:|
| 8 | 0 | 18 | 5 | 14 | 1 | 1 |

Findings: ❌ 10 fail · ⚠️ 11 warn · ℹ️ 0 info

| | Rule | Where | Message |
|---|---|---|---|
| ❌ | `guarantee-placeholder` | src/application/cancel-order.ts:15 | CancelOrderUseCase#cancelOrder: @throws TODO is still a placeholder |
| ❌ | `guarantee-placeholder` | src/application/cancel-order.ts:18 | CancelOrderUseCase#cancelOrder: @guarantee TODO is still a placeholder |
| ❌ | `guarantee-placeholder` | src/application/cancel-order.ts:20 | CancelOrderUseCase#cancelOrder has only placeholder guarantees |
| ❌ | `guarantee-placeholder` | src/ports/clock.ts:4 | Clock: @guarantee TODO is still a placeholder |
| ❌ | `guarantee-placeholder` | src/ports/clock.ts:6 | Clock has only placeholder guarantees |
| ❌ | `guarantee-placeholder` | src/ports/notification-gateway.ts:4 | NotificationGateway: @guarantee TODO is still a placeholder |
| ❌ | `guarantee-placeholder` | src/ports/notification-gateway.ts:6 | NotificationGateway has only placeholder guarantees |
| ❌ | `guarantee-placeholder` | src/ports/transaction-runner.ts:4 | TransactionRunner: @guarantee TODO is still a placeholder |
| ❌ | `guarantee-placeholder` | src/ports/transaction-runner.ts:6 | TransactionRunner has only placeholder guarantees |
| ❌ | `test-orphan` | tests/domain/money.test.ts:14 | test names "addMoney.ok.nonexistent" but no guarantee with that key exists |
| ⚠️ | `env-input-direct` | src/application/cancel-order.ts:26 | CancelOrderUseCase#cancelOrder reads an environment input directly (new Date); route it through a port |
| ⚠️ | `test-todo` | tests/application/place-order.test.ts:8 | PlaceOrderUseCase#placeOrder.err.empty is still test.todo |
| ⚠️ | `test-todo` | tests/application/place-order.test.ts:14 | PlaceOrderUseCase#placeOrder.ok.notified is still test.todo |
| ⚠️ | `test-todo` | tests/application/place-order.test.ts:15 | PlaceOrderUseCase#placeOrder.atomic is still test.todo |
| ⚠️ | `test-todo` | tests/application/place-order.test.ts:16 | PlaceOrderUseCase#placeOrder.frame is still test.todo |
| ⚠️ | `test-todo` | tests/domain/money.test.ts:24 | addMoney.ok.pure is still test.todo |
| ⚠️ | `test-todo` | tests/domain/period.test.ts:9 | isWithinPeriod.ok.within is still test.todo |
| ⚠️ | `test-todo` | tests/domain/period.test.ts:10 | isWithinPeriod.ok.outside is still test.todo |
| ⚠️ | `test-todo` | tests/domain/period.test.ts:11 | isWithinPeriod.ok.unbounded is still test.todo |
| ⚠️ | `test-todo` | tests/ports/order-repository.test.ts:5 | OrderRepository.ok.not-found is still test.todo |
| ⚠️ | `test-todo` | tests/ports/order-repository.test.ts:6 | OrderRepository.ok.round-trip is still test.todo |

<details><summary>Guarantee matrix</summary>

| Unit | Guarantee | Kind | Tests |
|---|---|---|---|
| `CancelOrderUseCase#cancelOrder` | `TODO` what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag) | other | — |
| `CancelOrderUseCase#cancelOrder` | `TODO` condition under which OrderNotFoundError is thrown | other | — |
| `PlaceOrderUseCase#placeOrder` | `ok.stored` after the call OrderRepository holds an order with status PLACED whose total is the sum of items prices | ok | 1 |
| `PlaceOrderUseCase#placeOrder` | `ok.notified` NotificationGateway recorded exactly one orderPlaced(accountId, result) | ok | 1 |
| `PlaceOrderUseCase#placeOrder` | `atomic` when any port fails, OrderRepository and NotificationGateway are unchanged | atomic | 1 |
| `PlaceOrderUseCase#placeOrder` | `frame` ports outside `@modifies` are unchanged | frame | 1 |
| `PlaceOrderUseCase#placeOrder` | `err.empty` items is empty; no state changes | err | 1 |
| `addMoney` | `ok.sum` result.amount = a.amount + b.amount and result.currency = a.currency | ok | 1 |
| `addMoney` | `ok.pure` a and b are unchanged after the call | ok | 1 |
| `addMoney` | `err.currency-mismatch` a.currency differs from b.currency | err | 1 |
| `isWithinPeriod` | `ok.within` Clock.now ∈ [period.start, period.end] gives result = true | ok | 1 |
| `isWithinPeriod` | `ok.outside` Clock.now outside the interval gives result = false | ok | 1 |
| `isWithinPeriod` | `ok.unbounded` period = null (no limit) gives result = true | ok | 1 |
| `Clock` | `TODO` what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag) | other | — |
| `NotificationGateway` | `TODO` what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag) | other | — |
| `OrderRepository` | `ok.not-found` findById with an unknown orderId gives result = null | ok | 1 |
| `OrderRepository` | `ok.round-trip` after save(order), findById(order.orderId) is equal to order | ok | 1 |
| `TransactionRunner` | `TODO` what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag) | other | — |

</details>

