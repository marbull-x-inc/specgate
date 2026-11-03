/**
 * Current time. Domain and application code never call `Date.now` directly.
 * @port
 * @guarantee TODO what holds afterwards, in params and result
 */
export interface Clock {
  now(): Date;
}
