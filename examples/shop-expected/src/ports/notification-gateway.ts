/**
 * Outbound notifications. Tests observe what was recorded, not how it was sent.
 * @port
 * @guarantee TODO what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag)
 */
export interface NotificationGateway {
  orderPlaced(accountId: string, orderId: string): Promise<void>;
}
