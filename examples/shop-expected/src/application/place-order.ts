import { addMoney, type Money } from "../domain/money.ts";
import { EmptyOrderError } from "../errors.ts";
import type { Clock } from "../ports/clock.ts";
import type { NotificationGateway } from "../ports/notification-gateway.ts";
import type { OrderRepository } from "../ports/order-repository.ts";
import type { TransactionRunner } from "../ports/transaction-runner.ts";

export interface OrderItem {
  sku: string;
  price: Money;
}

export class PlaceOrderUseCase {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly orders: OrderRepository,
    private readonly notifications: NotificationGateway,
    private readonly clock: Clock,
  ) {}

  /**
   * Places an order for the given items and notifies the account.
   * @remarks The notification is sent after the order is stored so that a failed store never produces a message.
   * @param accountId - owner of the order
   * @param items - at least one item; all prices share one currency (see addMoney.err.currency-mismatch)
   * @returns the new orderId
   * @throws {@link EmptyOrderError} err.empty items is empty; no state changes
   * @uses TransactionRunner, OrderRepository, NotificationGateway, Clock
   * @modifies OrderRepository, NotificationGateway
   * @guarantee ok.stored after the call OrderRepository holds an order with status PLACED whose total is the sum of items prices
   * @guarantee ok.notified NotificationGateway recorded exactly one orderPlaced(accountId, result)
   * @guarantee atomic when any port fails, OrderRepository and NotificationGateway are unchanged
   * @guarantee frame ports outside `@modifies` are unchanged
   */
  async placeOrder(accountId: string, items: OrderItem[]): Promise<string> {
    const first = items[0];
    if (!first) throw new EmptyOrderError();
    const total = items.slice(1).reduce((acc, item) => addMoney(acc, item.price), first.price);
    const orderId = `ord_${this.clock.now().getTime()}`;
    await this.tx.run(async () => {
      await this.orders.save({ orderId, accountId, total, status: "PLACED" });
      await this.notifications.orderPlaced(accountId, orderId);
    });
    return orderId;
  }
}
