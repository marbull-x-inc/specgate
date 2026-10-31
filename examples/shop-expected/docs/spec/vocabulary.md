# Vocabulary

Words a guarantee may use besides parameters and `result`.

## Entities

### zMoney

Amount of money in minor units of one currency.  
src/domain/money.ts:9

Properties: `amount`, `currency`

Invariants:

- amount is a non-negative integer
- currency is a three-letter ISO 4217 code

### zPeriod

Closed interval of time.  
src/domain/period.ts:9

Properties: `start`, `end`

Invariants:

- start <= end

## Ports

### Clock

Current time. Domain and application code never call `Date.now` directly.  
src/ports/clock.ts:6

Members: `now`

### NotificationGateway

Outbound notifications. Tests observe what was recorded, not how it was sent.  
src/ports/notification-gateway.ts:6

Members: `orderPlaced`

### OrderRepository

Persistence of orders.  
src/ports/order-repository.ts:16

Members: `findById`, `save`, `listByAccount`

### TransactionRunner

Opens a transaction boundary; everything inside `fn` commits or rolls back together.  
src/ports/transaction-runner.ts:6

Members: `run`
