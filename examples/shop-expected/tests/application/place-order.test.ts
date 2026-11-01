import { describe, expect, test } from "@jest/globals";
import { createFaultRunner, createStub, fakeClock, faultRunnerControl, snapshotAll, stubReset } from "@marbull-x-inc/specgate/runtime";
import { PlaceOrderUseCase } from "../../src/application/place-order";
import type { Clock } from "../../src/ports/clock";
import type { NotificationGateway } from "../../src/ports/notification-gateway";
import type { OrderRepository } from "../../src/ports/order-repository";
import type { TransactionRunner } from "../../src/ports/transaction-runner";


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
  const tx = createFaultRunner<TransactionRunner>(["run"]);
  const orders = createStub<OrderRepository>(["findById", "save", "listByAccount"]);
  const notifications = createStub<NotificationGateway>(["orderPlaced"]);
  const clock = fakeClock();
  const sut = new PlaceOrderUseCase(tx, orders, notifications, clock);

  test.todo(
    "PlaceOrderUseCase#placeOrder.ok.notified NotificationGateway recorded exactly one orderPlaced(accountId, result)",
  );
  // atomicity needs contract-passing fakes with real state; stubs only record calls. Replace the stubs, then un-skip.
  test.skip("PlaceOrderUseCase#placeOrder.atomic when any port fails, OrderRepository and NotificationGateway are unchanged", async () => {
    await sut.placeOrder(/* accountId: string */ undefined, /* items: OrderItem[] */ undefined); // warm-up: counts transaction boundaries
    for (const k of faultRunnerControl(tx).failurePoints()) {
      for (const s of [orders, notifications]) stubReset(s);
      faultRunnerControl(tx).failAt(k);
      const before = snapshotAll({ orders, notifications });
      await expect(sut.placeOrder(/* accountId: string */ undefined, /* items: OrderItem[] */ undefined)).rejects.toThrow();
      expect(snapshotAll({ orders, notifications })).toEqual(before);
    }
  });
  test.todo("PlaceOrderUseCase#placeOrder.frame ports outside `@modifies` are unchanged");
});
