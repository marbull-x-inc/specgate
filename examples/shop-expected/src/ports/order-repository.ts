import type { Money } from "../domain/money.ts";

export interface Order {
  orderId: string;
  accountId: string;
  total: Money;
  status: "PLACED" | "CANCELLED";
}

/**
 * Persistence of orders.
 * @port
 * @guarantee ok.not-found findById with an unknown orderId gives result = null
 * @guarantee ok.round-trip after save(order), findById(order.orderId) is equal to order
 */
export interface OrderRepository {
  findById(orderId: string): Promise<Order | null>;
  save(order: Order): Promise<void>;
  listByAccount(accountId: string): Promise<Order[]>;
}
