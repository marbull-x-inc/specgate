/**
 * Current time. Domain and application code never call `Date.now` directly.
 * @port
 */
export interface Clock {
  now(): Date;
}
