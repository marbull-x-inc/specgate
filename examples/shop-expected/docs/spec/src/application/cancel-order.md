# src/application/cancel-order.ts

_Generated (timestamp omitted)._

## CancelOrderUseCase#cancelOrder

`CancelOrderUseCase#cancelOrder(orderId: string): Promise<void>`  
src/application/cancel-order.ts:20

TODO: one sentence on what cancelOrder does

### Why

TODO: why it is designed this way

### Parameters

| Name | Type | Constraint |
|---|---|---|
| `orderId` | `string` | TODO (string) |

### Guarantees

| Id | Kind | Statement | Tests | Since |
|---|---|---|---|---|
| `TODO` | other | what holds afterwards, in params, result and declared ports | — |  |
| `TODO` | other | throws `OrderNotFoundError` — when OrderNotFoundError is thrown | — |  |

### How it runs (extracted from the implementation)

| Port | Member | Calls | Declared |
|---|---|---|---|
| `TransactionRunner` | `run` | 1 | uses |
| `OrderRepository` | `findById` | 1 | uses |
| `OrderRepository` | `save` | 1 | uses |

Direct environment inputs: `new Date` (line 26)

Referenced by: `src/main.ts`
