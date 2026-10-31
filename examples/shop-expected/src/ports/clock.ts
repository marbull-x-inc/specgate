/**
 * Current time. Domain and application code never call `Date.now` directly.
 * @port
 * @guarantee TODO what holds after a successful call, in terms of params, result and declared ports (replace TODO with an id; list the ports whose state changes in the modifies tag, or drop that tag)
 */
export interface Clock {
  now(): Date;
}
