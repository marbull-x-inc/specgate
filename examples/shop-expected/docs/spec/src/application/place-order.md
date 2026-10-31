# src/application/place-order.ts

_Generated (timestamp omitted)._

## PlaceOrderUseCase#placeOrder

`PlaceOrderUseCase#placeOrder(accountId: string, items: OrderItem[]): Promise<string>`  
src/application/place-order.ts:35

Places an order for the given items and notifies the account.

### Why

The notification is sent after the order is stored so that a failed store never produces a message.

### Parameters

| Name | Type | Constraint |
|---|---|---|
| `accountId` | `string` | owner of the order |
| `items` | `OrderItem[]` | at least one item; all prices share one currency (see addMoney.err.currency-mismatch) |

### Guarantees

| Id | Kind | Statement | Tests | Since |
|---|---|---|---|---|
| `ok.stored` | ok | after the call OrderRepository holds an order with status PLACED whose total is the sum of items prices | `tests/application/place-order.test.ts:5` |  |
| `ok.notified` | ok | NotificationGateway recorded exactly one orderPlaced(accountId, result) | `tests/application/place-order.test.ts:14` |  |
| `atomic` | atomic | when any port fails, OrderRepository and NotificationGateway are unchanged | `tests/application/place-order.test.ts:15` |  |
| `frame` | frame | ports outside `@modifies` are unchanged | `tests/application/place-order.test.ts:16` |  |
| `err.empty` | err | throws `EmptyOrderError` — items is empty; no state changes | `tests/application/place-order.test.ts:8` |  |

### How it runs (extracted from the implementation)

| Port | Member | Calls | Declared |
|---|---|---|---|
| `Clock` | `now` | 1 | uses |
| `TransactionRunner` | `run` | 1 | uses |
| `OrderRepository` | `save` | 1 | modifies |
| `NotificationGateway` | `orderPlaced` | 1 | modifies |

Calls public operations: [`addMoney`](#addmoney)

Referenced by: `src/main.ts`

### Tests

- `PlaceOrderUseCase#placeOrder.ok.stored` — tests/application/place-order.test.ts:5
- `PlaceOrderUseCase#placeOrder.err.empty` (todo) — tests/application/place-order.test.ts:8
- `PlaceOrderUseCase#placeOrder.ok.notified` (todo) — tests/application/place-order.test.ts:14
- `PlaceOrderUseCase#placeOrder.atomic` (todo) — tests/application/place-order.test.ts:15
- `PlaceOrderUseCase#placeOrder.frame` (todo) — tests/application/place-order.test.ts:16
