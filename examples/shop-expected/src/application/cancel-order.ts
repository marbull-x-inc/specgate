import { OrderNotFoundError } from "../errors.ts";
import type { OrderRepository } from "../ports/order-repository.ts";
import type { TransactionRunner } from "../ports/transaction-runner.ts";

export class CancelOrderUseCase {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly orders: OrderRepository,
  ) {}

  /**
   * TODO: one sentence on what cancelOrder does
   * @remarks TODO: why it is designed this way
   * @param orderId - TODO (string)
   * @throws {@link OrderNotFoundError} TODO condition under which OrderNotFoundError is thrown
   * @uses TransactionRunner, OrderRepository
   * @modifies TODO
   * @guarantee TODO what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag)
   */
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
