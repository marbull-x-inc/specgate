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
| `TODO` | other | what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag) | — |  |
| `TODO` | other | throws `OrderNotFoundError` — condition under which OrderNotFoundError is thrown | — |  |

### How it runs (extracted from the implementation)

| Port | Member | Calls | Declared |
|---|---|---|---|
| `TransactionRunner` | `run` | 1 | uses |
| `OrderRepository` | `findById` | 1 | uses |
| `OrderRepository` | `save` | 1 | uses |

Direct environment inputs: `new Date` (line 26)

Referenced by: `src/main.ts`
