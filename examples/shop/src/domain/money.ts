import { z } from "zod";

/**
 * Amount of money in minor units of one currency.
 * @entity
 * @invariant amount is a non-negative integer
 * @invariant currency is a three-letter ISO 4217 code
 */
export const zMoney = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof zMoney>;

/**
 * Adds two amounts of the same currency.
 * @remarks Mixing currencies is a programming error, not user input, so it throws instead of returning a result type.
 * @param a - first operand
 * @param b - second operand, must share `a.currency`
 * @returns a new Money; neither operand is mutated
 * @throws {@link RangeError} err.currency-mismatch a.currency differs from b.currency
 * @guarantee ok.sum result.amount = a.amount + b.amount and result.currency = a.currency
 * @guarantee ok.pure a and b are unchanged after the call
 * @example
 * ```ts
 * addMoney({ amount: 1, currency: "JPY" }, { amount: 2, currency: "JPY" }) // => { amount: 3, currency: "JPY" }
 * ```
 */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new RangeError("currency mismatch");
  return { amount: a.amount + b.amount, currency: a.currency };
}
