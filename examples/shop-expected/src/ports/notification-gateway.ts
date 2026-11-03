/**
 * Outbound notifications. Tests observe what was recorded, not how it was sent.
 * @port
 * @guarantee TODO what holds afterwards, in params and result
 */
export interface NotificationGateway {
  orderPlaced(accountId: string, orderId: string): Promise<void>;
}
