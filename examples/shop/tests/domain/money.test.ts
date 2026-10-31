import { describe, expect, test } from "@jest/globals";
import { addMoney } from "../../src/domain/money.ts";

describe("addMoney", () => {
  test("addMoney.ok.sum adds amounts of the same currency", () => {
    expect(addMoney({ amount: 1, currency: "JPY" }, { amount: 2, currency: "JPY" })).toEqual({
      amount: 3,
      currency: "JPY",
    });
  });
  test("addMoney.err.currency-mismatch throws RangeError", () => {
    expect(() => addMoney({ amount: 1, currency: "JPY" }, { amount: 2, currency: "USD" })).toThrow(RangeError);
  });
  test("addMoney.ok.nonexistent this guarantee does not exist (orphan)", () => {
    expect(true).toBe(true);
  });
  test("adds without naming a guarantee (unlinked)", () => {
    expect(true).toBe(true);
  });
});
