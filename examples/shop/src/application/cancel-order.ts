import { OrderNotFoundError } from "../errors.ts";
import type { OrderRepository } from "../ports/order-repository.ts";
import type { TransactionRunner } from "../ports/transaction-runner.ts";

export class CancelOrderUseCase {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly orders: OrderRepository,
  ) {}

  async cancelOrder(orderId: string): Promise<void> {
    await this.tx.run(async () => {
      const order = await this.orders.findById(orderId);
      if (!order) throw new OrderNotFoundError(orderId);
      await this.orders.save({ ...order, status: "CANCELLED" });
    });
    this.lastCancelledAt = new Date();
  }

  private lastCancelledAt: Date | undefined;

  private log(): void {}
}
