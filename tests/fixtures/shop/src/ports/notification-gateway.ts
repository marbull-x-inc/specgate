/**
 * Outbound notifications. Tests observe what was recorded, not how it was sent.
 * @port
 */
export interface NotificationGateway {
  orderPlaced(accountId: string, orderId: string): Promise<void>;
}
