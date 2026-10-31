import { CancelOrderUseCase } from "./application/cancel-order.ts";
import { PlaceOrderUseCase } from "./application/place-order.ts";
import { addMoney } from "./domain/money.ts";
import { isWithinPeriod } from "./domain/period.ts";
import type { Clock } from "./ports/clock.ts";
import type { NotificationGateway } from "./ports/notification-gateway.ts";
import type { OrderRepository } from "./ports/order-repository.ts";
import type { TransactionRunner } from "./ports/transaction-runner.ts";

export function wire(tx: TransactionRunner, orders: OrderRepository, notifications: NotificationGateway, clock: Clock) {
  return {
    placeOrder: new PlaceOrderUseCase(tx, orders, notifications, clock),
    cancelOrder: new CancelOrderUseCase(tx, orders),
    addMoney,
    isWithinPeriod,
  };
}
