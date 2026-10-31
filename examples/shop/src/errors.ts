export class EmptyOrderError extends Error {
  constructor() {
    super("order has no items");
  }
}
export class OrderNotFoundError extends Error {
  constructor(public readonly orderId: string) {
    super(`order not found: ${orderId}`);
  }
}
export class InvalidPeriodError extends Error {}
