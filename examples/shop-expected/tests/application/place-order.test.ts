import { describe, expect, test } from "@jest/globals";

describe("PlaceOrderUseCase", () => {
  describe("placeOrder", () => {
    test("ok.stored stores a PLACED order with the summed total", async () => {
      expect(1).toBe(1);
    });
    test.todo("err.empty rejects an empty item list");
  });
});

// specgate gen (2026-01-01): guarantees without a test. Move them into the describe above as you implement them.
describe("PlaceOrderUseCase#placeOrder (specgate)", () => {
  test.todo("PlaceOrderUseCase#placeOrder.ok.notified NotificationGateway recorded exactly one orderPlaced(accountId, result)");
  test.todo("PlaceOrderUseCase#placeOrder.atomic when any port fails, OrderRepository and NotificationGateway are unchanged");
  test.todo("PlaceOrderUseCase#placeOrder.frame ports outside `@modifies` are unchanged");
});
