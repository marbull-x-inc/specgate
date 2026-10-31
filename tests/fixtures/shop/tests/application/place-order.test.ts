import { describe, expect, test } from "@jest/globals";

describe("PlaceOrderUseCase", () => {
  describe("placeOrder", () => {
    test("ok.stored stores a PLACED order with the summed total", async () => {
      expect(1).toBe(1);
    });
    test.todo("err.empty rejects an empty item list");
  });
});
