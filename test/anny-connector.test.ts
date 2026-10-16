import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnyApiError, AnnyConnector } from "../src/providers/anny/anny-connector.js";
import type { AnnyConnectorOptions } from "../src/providers/anny/anny-connector.js";
import {
  BOOKING_ID,
  BOOKING_PATH,
  ORG,
  bookingDoc,
  stubFetch,
  type Responder,
} from "./anny-fixtures.js";

const make = (responder: Responder, options: AnnyConnectorOptions = {}) => {
  const calls = stubFetch(responder);
  const connector = new AnnyConnector("example", () => Promise.resolve("secret-token"), {
    baseUrl: "https://b.anny.co/",
    organization: ORG,
    locale: "de-DE",
    ...options,
  });
  return { connector, calls };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AnnyConnector — admin access", () => {
  it("sends auth, accept and organization context on reads", async () => {
    const { connector, calls } = make(() => ({ body: { data: [] } }));
    await connector.listBookings({
      range: "next_7_days",
      status: ["accepted", "requested"],
      hideBlockers: true,
      include: "resource",
      pageSize: 50,
    });
    const [call] = calls;
    expect(call?.url.href.split("?")[0]).toBe("https://b.anny.co/api/v1/bookings");
    expect(call?.headers.Authorization).toBe("Bearer secret-token");
    expect(call?.headers.Accept).toContain("application/vnd.api+json");
    expect(call?.headers["Accept-Language"]).toBe("de-DE");
    const q = call?.url.searchParams;
    expect(q?.get("o")).toBe(ORG);
    expect(q?.get("filter[start_date_range]")).toBe("next_7_days");
    expect(q?.getAll("filter[status][]")).toEqual(["accepted", "requested"]);
    expect(q?.get("filter[hide_blocker]")).toBe("true");
    expect(q?.get("page[size]")).toBe("50");
    expect(q?.has("filter[search]")).toBe(false);
  });

  it("maps the range field and list filters", async () => {
    const { connector, calls } = make(() => ({ body: { data: [] } }));
    await connector.listBookings({ range: "today", rangeField: "created" });
    await connector.listResources({ filter: { booked_today: true, tags: ["a"] } });
    expect(calls[0]?.url.searchParams.get("filter[created_at_range]")).toBe("today");
    expect(calls[1]?.url.pathname).toBe("/api/v1/resources");
    expect(calls[1]?.url.searchParams.get("filter[booked_today]")).toBe("true");
    expect(calls[1]?.url.searchParams.getAll("filter[tags][]")).toEqual(["a"]);
  });

  it("does not override an explicit organization", () => {
    const { connector } = make(() => ({}));
    const url = new URL(connector.buildUrl("/api/v1/bookings", { o: "other" }));
    expect(url.searchParams.getAll("o")).toEqual(["other"]);
  });

  it("refuses GET routes that change data without calling anny", async () => {
    const { connector, calls } = make(() => ({ body: {} }));
    await expect(connector.get(`${BOOKING_PATH}/cancel`)).rejects.toThrow(/booking_change_plan/);
    await expect(connector.get("/api/v1/invoices/x/send")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("sends JSON:API documents as vnd.api+json and plain objects as JSON", async () => {
    const { connector, calls } = make(() => ({ body: bookingDoc("accepted") }));
    const doc = { data: { type: "bookings", id: BOOKING_ID, attributes: { status: "accepted" } } };
    const res = await connector.send({ method: "PATCH", path: BOOKING_PATH, body: doc });
    await connector.send({ method: "POST", path: "/api/v1/bookings/instant", body: { a: 1 } });
    expect(res.status).toBe(200);
    expect(calls[0]?.headers["Content-Type"]).toBe("application/vnd.api+json");
    expect(calls[0]?.body).toEqual(doc);
    expect(calls[1]?.headers["Content-Type"]).toBe("application/json");
  });

  it("explains auth failures without leaking the token", async () => {
    const { connector } = make(() => ({
      status: 401,
      body: { errors: [{ status: "401", title: "Unauthenticated." }] },
    }));
    const error = await connector.get("/api/v1/bookings").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnnyApiError);
    expect((error as Error).message).toMatch(/401 Unauthenticated\..*credential_rotate/);
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("uses the sign-in hint for OAuth connectors", async () => {
    const { connector } = make(() => ({ status: 401, body: { errors: [] } }), {
      signInHint: "Sign in with booking_login.",
    });
    await expect(connector.get("/api/v1/bookings")).rejects.toThrow(/booking_login/);
  });

  it("retries a rate-limited read once after Retry-After", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { connector, calls } = make(() =>
      ++n === 1
        ? { status: 429, headers: { "retry-after": "1" }, body: { errors: [] } }
        : { body: { data: [] } },
    );
    const pending = connector.get("/api/v1/resources");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ data: [] });
    expect(calls).toHaveLength(2);
  });

  it("does not retry writes on 429", async () => {
    const { connector, calls } = make(() => ({ status: 429, headers: { "retry-after": "1" } }));
    await expect(
      connector.send({ method: "POST", path: "/api/v1/bookings", body: { data: {} } }),
    ).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it("refuses plain http to remote hosts", async () => {
    const { connector } = make(() => ({}), { baseUrl: "http://b.anny.co" });
    await expect(connector.get("/api/v1/bookings")).rejects.toThrow(/https/);
  });

  it("omits Authorization when the token source has none", async () => {
    const calls = stubFetch(() => ({ body: [] }));
    const connector = new AnnyConnector("example", () => Promise.resolve(null));
    await connector.availability({ kind: "next-date", serviceId: "s1" });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.url.origin).toBe("https://b.anny.co");
  });

  it("whoami tolerates one failing half", async () => {
    const { connector } = make((call) =>
      call.url.pathname.endsWith("/user")
        ? { body: { data: { type: "users", id: "u1", attributes: { name: "T" } } } }
        : { status: 403, body: { errors: [{ detail: "nope" }] } },
    );
    expect(await connector.whoami()).toEqual({
      user: { type: "users", id: "u1", name: "T" },
      organization: null,
    });
  });

  it.each([
    ["next-date", "/api/v1/availability/next-date"],
    ["start-dates", "/api/v1/availability/start-dates"],
    ["start", "/api/v1/availability/start"],
    ["service-configuration", "/api/v1/service-configuration"],
  ] as const)("queries availability kind %s", async (kind, path) => {
    const { connector, calls } = make(() => ({ body: [] }));
    await connector.availability({
      kind,
      serviceId: "s1",
      date: "2026-10-20",
      startDate: "2026-10-01",
    });
    expect(calls[0]?.url.pathname).toBe(path);
    expect(calls[0]?.url.searchParams.get("service_id")).toBe("s1");
  });
});

describe("AnnyConnector — customer access", () => {
  const customer = (responder: Responder) =>
    make(responder, { access: "customer", organization: "example-org" });

  it("reads the signed-in customer and their own bookings with Customer API filters", async () => {
    const { connector, calls } = customer((call) =>
      call.url.pathname === "/api/v1/customer-account"
        ? { body: { data: { type: "customer-accounts", id: "c1", attributes: {} } } }
        : { body: { data: [] } },
    );
    expect(connector.access).toBe("customer");
    expect((await connector.whoami()).user).toMatchObject({ id: "c1" });
    await connector.listBookings({ range: "2026-10-01:2026-10-31", services: ["s"] });
    await connector.listBookings({ range: "future" });
    const q = calls[1]?.url.searchParams;
    expect(q?.get("filter[start_date]")).toBe("2026-10-01");
    expect(q?.get("filter[end_date]")).toBe("2026-10-31");
    expect(q?.has("filter[services][]")).toBe(false);
    expect(q?.has("o")).toBe(false);
    expect(calls[2]?.url.searchParams.get("filter[upcoming_only]")).toBe("true");
    await expect(connector.listBookings({ range: "next_7_days" })).rejects.toThrow(
      /YYYY-MM-DD:YYYY-MM-DD/,
    );
  });

  it("lists resources and services through the organization slug", async () => {
    const { connector, calls } = customer(() => ({ body: { data: [] } }));
    await connector.listResources({});
    await connector.listServices({});
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v1/organizations/example-org/resources",
      "/api/v1/organizations/example-org/services",
    ]);
    const noSlug = make(() => ({}), { access: "customer", organization: undefined }).connector;
    expect(() => noSlug.listResources({})).toThrow(/organization slug/);
  });

  it("refuses admin-only reads", async () => {
    const { connector, calls } = customer(() => ({ body: {} }));
    await expect(connector.getBooking(BOOKING_ID)).rejects.toThrow(/admin access/);
    expect(() => connector.listCustomers({})).toThrow(/admin access/);
    expect(() => connector.listOrders({})).toThrow(/admin access/);
    expect(calls).toHaveLength(0);
  });
});
