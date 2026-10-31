/**
 * Opens a transaction boundary; everything inside `fn` commits or rolls back together.
 * @port
 */
export interface TransactionRunner {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
