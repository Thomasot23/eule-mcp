import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import { AnnyConnector } from "../src/providers/anny/anny-connector.js";
import { BookingService } from "../src/services/booking-service.js";
import { registerBookingTools } from "../src/tools/booking-tools.js";
import { BOOKING_ID, BOOKING_PATH, bookingDoc, stubFetch } from "./anny-fixtures.js";

async function connect() {
  const calls = stubFetch((call) =>
    call.url.pathname === "/api/v1/bookings"
      ? { body: { data: [bookingDoc().data], meta: { page: { total: 1 } } } }
      : { body: bookingDoc(call.url.pathname.endsWith("/cancel") ? "canceled" : "requested") },
  );
  const registry = {
    getBookingConnectors: vi.fn(() => [new AnnyConnector("example", () => Promise.resolve("t"))]),
    getBookingSignInTargets: vi.fn(() => []),
  } as unknown as ConnectorRegistry;
  const server = new McpServer({ name: "eule", version: "test" });
  registerBookingTools(server, new BookingService(registry));
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { text, isError: res.isError === true };
  };
  return { client, call, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("booking tools", () => {
  it("annotates every tool that can change anny or local state", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const writable = tools
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => t.name)
      .sort();
    expect(writable).toEqual(["booking_change_apply", "booking_login", "booking_logout"]);
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
    expect(destructive.map((t) => t.name)).toEqual(["booking_change_apply"]);
  });

  it("lists bookings with sensible defaults", async () => {
    const { call, calls } = await connect();
    const { text, isError } = await call("booking_list", { range: "today" });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ total: 1, data: [{ id: BOOKING_ID }] });
    const q = calls[0]?.url.searchParams;
    expect(q?.get("include")).toBe("resource,service,customer");
    expect(q?.get("sort")).toBe("start_date");
  });

  it("refuses side-effect GETs in booking_api_get", async () => {
    const { call, calls } = await connect();
    const res = await call("booking_api_get", { path: `${BOOKING_PATH}/cancel` });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/booking_change_plan/);
    expect(calls).toHaveLength(0);
  });

  it("walks plan → list → apply", async () => {
    const { call, calls } = await connect();
    const planned = await call("booking_change_plan", { action: "cancel", booking_id: BOOKING_ID });
    expect(planned.text).toMatch(/explicitly confirmed/);
    const planId = /chg_[0-9a-f]{8}/.exec(planned.text)?.[0] ?? "";
    expect((await call("booking_change_list")).text).toContain(planId);
    expect(calls.map((c) => c.url.pathname)).toEqual([BOOKING_PATH]);

    const applied = await call("booking_change_apply", { plan_id: planId });
    expect(applied.isError).toBe(false);
    expect(applied.text).toContain("canceled");
    expect(calls.at(-1)?.url.pathname).toBe(`${BOOKING_PATH}/cancel`);
    expect((await call("booking_change_list")).text).toBe("No pending change plans.");
    expect((await call("booking_change_discard", { plan_id: planId })).text).toMatch(/No pending/);
  });

  it("explains how to set up sign-in", async () => {
    const { call } = await connect();
    const res = await call("booking_login", { role: "work" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/anny-oauth/);
  });
});
