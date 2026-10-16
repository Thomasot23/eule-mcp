import { describe, expect, it } from "vitest";
import {
  classifyRequest,
  isReadEndpoint,
  normalizeApiPath,
  readableTarget,
} from "../src/providers/anny/endpoint-policy.js";

const BOOKING = "/api/v1/bookings/0b5e1d2c-1111-4222-8333-944455556666";

describe("normalizeApiPath", () => {
  it("keeps valid paths and drops a trailing slash", () => {
    expect(normalizeApiPath("/api/v1/bookings/")).toBe("/api/v1/bookings");
    expect(normalizeApiPath(` ${BOOKING} `)).toBe(BOOKING);
  });

  it.each([
    "/api/v2/bookings",
    "https://evil.example/api/v1/bookings",
    "/api/v1/bookings?o=other",
    "/api/v1/bookings#x",
    "/api/v1/../v1/bookings",
    "/api/v1/bookings//cancel",
    "/api/v1/bookings/a b",
    "/api/v1/bookings/%2e%2e",
  ])("rejects %s", (path) => {
    expect(() => normalizeApiPath(path)).toThrow();
  });
});

describe("classifyRequest", () => {
  it.each([
    "/api/v1/bookings",
    BOOKING,
    `${BOOKING}/scans`,
    "/api/v1/resources",
    "/api/v1/resources/raum-a-101/timeslots",
    "/api/v1/customers",
    "/api/v1/organization",
    "/api/v1/availability/start",
    "/api/v1/availability/start-dates",
    "/api/v1/service-configuration",
    "/api/v1/bookings/by-number",
  ])("treats GET %s as a read", (path) => {
    expect(classifyRequest("GET", path)).toBe("read");
  });

  // anny routes with side effects behind GET — all must need confirmation.
  it.each([
    `${BOOKING}/cancel`,
    "/api/v1/orders/123/cancel",
    "/api/v1/invoices/abc/send",
    "/api/v1/invoices/abc/set-paid",
    "/api/v1/invoices/abc/cancel",
    "/api/v1/broadcast-campaigns/abc/start",
    "/api/v1/export-schedules/abc/run",
    "/api/v1/services/my-service/duplicate",
    "/api/v1/customers/abc/remove-from-community",
    "/api/v1/booking-passes/abc/cancel",
    "/api/v1/bookings/export",
    "/api/v1/customers/export",
    "/api/v1/invoices/export",
    "/api/v1/order",
    "/api/v1/order/bookings/delete-all",
    "/api/v1/communities/abc/leave",
    "/api/v1/bookings/instant",
    "/api/v1/booking-passes/checkout",
    "/api/v1/something-undocumented",
    `${BOOKING}/something-undocumented`,
  ])("treats GET %s as a write", (path) => {
    expect(classifyRequest("GET", path)).toBe("write");
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "treats %s as a write even on a read path",
    (method) => {
      expect(classifyRequest(method, BOOKING)).toBe("write");
    },
  );
});

describe("readableTarget", () => {
  it("finds the record an action targets", () => {
    expect(readableTarget(`${BOOKING}/cancel`)).toBe(BOOKING);
    expect(readableTarget(BOOKING)).toBe(BOOKING);
  });

  it("does not fall back to a collection", () => {
    expect(readableTarget("/api/v1/bookings")).toBeUndefined();
    expect(isReadEndpoint("/api/v1/bookings")).toBe(true);
  });
});
