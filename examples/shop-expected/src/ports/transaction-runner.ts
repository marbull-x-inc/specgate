/**
 * Opens a transaction boundary; everything inside `fn` commits or rolls back together.
 * @port
 * @guarantee TODO what holds afterwards, in params and result
 */
export interface TransactionRunner {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
