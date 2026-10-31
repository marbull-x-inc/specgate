/**
 * Opens a transaction boundary; everything inside `fn` commits or rolls back together.
 * @port
 * @guarantee TODO what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag)
 */
export interface TransactionRunner {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
