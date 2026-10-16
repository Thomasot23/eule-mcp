import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessMode } from "../src/config/index.js";
import type { BookingSignInTarget, ConnectorRegistry } from "../src/connectors/index.js";
import { AnnyConnector } from "../src/providers/anny/anny-connector.js";
import { AnnyTokenStore } from "../src/providers/anny/anny-auth.js";
import { BookingService } from "../src/services/booking-service.js";
import { ChangePlanStore, PLAN_TTL_MS } from "../src/services/change-plan-store.js";
import type { BookingAccess, BookingConnector } from "../src/types/index.js";
import { BOOKING_ID, BOOKING_PATH, ORG, bookingDoc, stubFetch } from "./anny-fixtures.js";

interface Setup {
  access?: BookingAccess;
  /** Simulates a role whose policy is readOnly: write selection returns nothing. */
  readOnly?: boolean;
  now?: () => number;
  connectors?: BookingConnector[];
  targets?: BookingSignInTarget[];
}

function setup(options: Setup = {}) {
  const calls = stubFetch((call) => {
    if (call.method === "GET" && call.url.pathname === BOOKING_PATH) return { body: bookingDoc() };
    if (call.url.pathname === "/api/v1/bookings" && call.method === "GET")
      return { body: { data: [] } };
    if (call.url.pathname.endsWith("/cancellation-preview"))
      return { body: { fee: 0, refund: 10 } };
    return { body: bookingDoc("accepted") };
  });
  const connector = new AnnyConnector("example", () => Promise.resolve("t"), {
    organization: options.access === "customer" ? "example-org" : ORG,
    access: options.access ?? "admin",
  });
  const connectors = options.connectors ?? [connector];
  const getBookingConnectors = vi.fn((_role: string | undefined, mode: AccessMode = "read") =>
    mode === "write" && options.readOnly ? [] : [...connectors],
  );
  const registry = {
    getBookingConnectors,
    getBookingSignInTargets: vi.fn(() => options.targets ?? []),
  } as unknown as ConnectorRegistry;
  const service = new BookingService(registry, new ChangePlanStore(options.now));
  const writes = () =>
    calls.filter((c) => !(c.method === "GET" && c.url.pathname === BOOKING_PATH));
  return { service, calls, writes, getBookingConnectors };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BookingService connector selection", () => {
  it("explains a missing connector", async () => {
    const { service } = setup({ connectors: [] });
    await expect(service.listBookings({}, "work")).rejects.toThrow(
      /No usable booking connector is configured for role "work"/,
    );
  });

  it("refuses ambiguous connectors", async () => {
    const a = new AnnyConnector("a", () => Promise.resolve("t"));
    const b = new AnnyConnector("b", () => Promise.resolve("t"));
    const { service } = setup({ connectors: [a, b] });
    await expect(service.whoami()).rejects.toThrow(/Several booking connectors match \(a, b\)/);
  });

  it("lets a read-only role read but not plan", async () => {
    const { service, writes } = setup({ readOnly: true });
    await expect(service.listBookings({}, "work")).resolves.toBeDefined();
    await expect(
      service.planChange({ action: "accept", bookingId: BOOKING_ID }, "work"),
    ).rejects.toThrow(/not permitted for role "work"/);
    expect(writes().filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("BookingService change plans (admin)", () => {
  it("planning only reads the target; applying sends exactly the planned request once", async () => {
    const { service, calls, writes, getBookingConnectors } = setup();
    const plan = await service.planChange({ action: "accept", bookingId: BOOKING_ID }, "work");

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET ${BOOKING_PATH}`]);
    expect(plan).toMatchObject({ account: "example", role: "work" });
    expect(plan.before).toMatchObject({ id: BOOKING_ID, status: "requested" });
    expect(plan.request).toEqual({
      method: "PATCH",
      path: BOOKING_PATH,
      body: { data: { type: "bookings", id: BOOKING_ID, attributes: { status: "accepted" } } },
    });

    const applied = await service.applyChange(plan.id);
    expect(applied.result).toMatchObject({ status: "accepted" });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body).toEqual(plan.request.body);
    expect(getBookingConnectors).toHaveBeenLastCalledWith("work", "write");

    await expect(service.applyChange(plan.id)).rejects.toThrow(/already applied or expired/);
    expect(writes()).toHaveLength(1);
  });

  it.each([
    ["reject", "PATCH", BOOKING_PATH],
    ["cancel", "GET", `${BOOKING_PATH}/cancel`],
    ["check_in", "POST", `${BOOKING_PATH}/check-in`],
    ["check_out", "POST", `${BOOKING_PATH}/check-out`],
  ] as const)("builds the %s preset", async (action, method, path) => {
    const { service } = setup();
    const plan = await service.planChange({ action, bookingId: BOOKING_ID });
    expect(plan.request.method).toBe(method);
    expect(plan.request.path).toBe(path);
  });

  it("refuses customer-only shortcuts", async () => {
    const { service } = setup();
    await expect(
      service.planChange({ action: "book", resourceId: "r", serviceId: "s" }),
    ).rejects.toThrow(/not available with admin access/);
  });

  it("re-checks the role at apply time", async () => {
    const first = new AnnyConnector("first", () => Promise.resolve("t"));
    const list: BookingConnector[] = [first];
    const { service, writes } = setup({ connectors: list });
    const plan = await service.planChange({ action: "cancel", bookingId: BOOKING_ID });
    list[0] = new AnnyConnector("other", () => Promise.resolve("t"));
    await expect(service.applyChange(plan.id)).rejects.toThrow(/was made for "first"/);
    expect(writes()).toHaveLength(0);
  });

  it("plans raw requests and validates them", async () => {
    const { service, writes } = setup();
    const plan = await service.planChange({
      method: "POST",
      path: "/api/v1/bookings/",
      body: { data: { type: "bookings", attributes: { is_blocker: true } } },
      title: "Block room 1.101",
    });
    expect(plan.title).toBe("Block room 1.101");
    expect(plan.request.path).toBe("/api/v1/bookings");
    expect(plan.before).toBeUndefined();

    await expect(service.planChange({ method: "GET", path: "/api/v1/bookings" })).rejects.toThrow(
      /is a read/,
    );
    await expect(
      service.planChange({ method: "PATCH", path: BOOKING_PATH, body: "x" as unknown as object }),
    ).rejects.toThrow(/JSON body/);
    await expect(
      service.planChange({ method: "PATCH", path: BOOKING_PATH, body: { data: { id: "other" } } }),
    ).rejects.toThrow(/does not match/);
    await expect(
      service.planChange({ method: "DELETE", path: BOOKING_PATH, body: { data: {} } }),
    ).rejects.toThrow(/no body/);
    await expect(
      service.planChange({
        action: "cancel",
        bookingId: BOOKING_ID,
        method: "GET",
        path: BOOKING_PATH,
      }),
    ).rejects.toThrow(/either/);
    await expect(service.planChange({ action: "cancel" })).rejects.toThrow(/booking_id/);
    await expect(service.planChange({ method: "DELETE" })).rejects.toThrow(/method and path/);
    await expect(
      service.planChange({ action: "cancel", bookingId: "../../organizations" }),
    ).rejects.toThrow(/Invalid path segment/);
    expect(writes()).toHaveLength(0);
  });

  it("expires and discards plans", async () => {
    let now = Date.parse("2026-10-16T10:00:00Z");
    const { service, writes } = setup({ now: () => now });
    const plan = await service.planChange({ action: "cancel", bookingId: BOOKING_ID });
    const other = await service.planChange({ action: "cancel", bookingId: BOOKING_ID });
    expect(service.discardPlan(other.id)).toBe(true);
    expect(service.listPlans()).toHaveLength(1);
    now += PLAN_TTL_MS + 1;
    expect(service.listPlans()).toHaveLength(0);
    await expect(service.applyChange(plan.id)).rejects.toThrow(/expired/);
    expect(writes()).toHaveLength(0);
  });
});

describe("BookingService change plans (customer)", () => {
  it("books a slot through the instant endpoint", async () => {
    const { service, writes } = setup({ access: "customer" });
    const plan = await service.planChange({
      action: "book",
      resourceId: "r1",
      serviceId: "s1",
      startDate: "2026-10-20T10:00:00+02:00",
      endDate: "2026-10-20T11:00:00+02:00",
    });
    expect(plan.request).toEqual({
      method: "POST",
      path: "/api/v1/bookings/instant",
      body: {
        start_date: "2026-10-20T10:00:00+02:00",
        end_date: "2026-10-20T11:00:00+02:00",
        resource_id: "r1",
        service_id: "s1",
      },
    });
    await service.applyChange(plan.id);
    expect(writes().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/v1/bookings/instant",
    ]);
    expect(writes()[0]?.headers["Content-Type"]).toBe("application/json");
    await expect(service.planChange({ action: "book", resourceId: "r1" })).rejects.toThrow(
      /needs resource_id, service_id/,
    );
  });

  it("previews the cancellation fee and refuses admin shortcuts", async () => {
    const { service, calls } = setup({ access: "customer" });
    const plan = await service.planChange({ action: "cancel", bookingId: BOOKING_ID });
    expect(plan.before).toEqual({ fee: 0, refund: 10 });
    expect(calls.map((c) => c.url.pathname)).toEqual([`${BOOKING_PATH}/cancellation-preview`]);
    await expect(service.planChange({ action: "accept", bookingId: BOOKING_ID })).rejects.toThrow(
      /not available with customer access \(available: book, cancel\)/,
    );
  });
});

describe("BookingService sign-in", () => {
  const target: BookingSignInTarget = {
    role: "work",
    connectorId: "anny",
    account: "example",
    key: "work/anny",
    clientId: "client",
    baseUrl: "https://b.anny.eu",
  };

  it("signs in through the matching anny-oauth connector and stores the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-login-"));
    try {
      const store = new AnnyTokenStore(join(dir, "t.json"));
      const authenticate = vi.fn(() =>
        Promise.resolve({ accessToken: "a", expiresAt: 1, clientId: "client" }),
      );
      const registry = {
        getBookingSignInTargets: vi.fn(() => [target]),
      } as unknown as ConnectorRegistry;
      const service = new BookingService(registry, new ChangePlanStore(), { authenticate, store });

      await service.login("work");
      expect(authenticate).toHaveBeenCalledWith({
        clientId: "client",
        baseUrl: "https://b.anny.eu",
      });
      expect(store.get("work/anny")?.accessToken).toBe("a");
      expect(service.logout("work").removed).toBe(true);
      expect(store.get("work/anny")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs in without a configured client ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-login-"));
    try {
      const store = new AnnyTokenStore(join(dir, "t.json"));
      const authenticate = vi.fn(() =>
        Promise.resolve({ accessToken: "a", expiresAt: 1, clientId: "registered" }),
      );
      const { clientId: _, ...withoutClient } = target;
      const registry = {
        getBookingSignInTargets: vi.fn(() => [withoutClient]),
      } as unknown as ConnectorRegistry;
      const service = new BookingService(registry, new ChangePlanStore(), { authenticate, store });

      await service.login("work");
      // No clientId: authenticateAnny registers (or reuses) Eule's own client.
      expect(authenticate).toHaveBeenCalledWith({ baseUrl: "https://b.anny.eu" });
      expect(store.get("work/anny")?.clientId).toBe("registered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explains missing or ambiguous sign-in connectors", async () => {
    const none = setup({ targets: [] }).service;
    await expect(none.login("work")).rejects.toThrow(/type "anny-oauth"/);
    const two = setup({
      targets: [target, { ...target, connectorId: "anny-2", key: "work/anny-2" }],
    }).service;
    expect(() => two.logout()).toThrow(/Pass role and connector_id/);
    expect(two.logout(undefined, "anny-2").target.key).toBe("work/anny-2");
  });
});
