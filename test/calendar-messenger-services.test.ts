import { describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/calendar-service.js";
import { MessengerService } from "../src/services/messenger-service.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import type { CalendarConnector, MessengerConnector } from "../src/types/index.js";

const calendar = (account: string, readOnly = false): CalendarConnector => ({
  account,
  tier: "test",
  readOnly,
  listCalendars: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  createEvent: vi.fn(async (event) => ({
    ...event,
    id: "1",
    account,
    isAllDay: false,
    attendees: event.attendees ?? [],
  })),
  updateEvent: vi.fn(async (id, event) => ({
    subject: "updated",
    start: "2026-01-01T10:00:00Z",
    end: "2026-01-01T11:00:00Z",
    ...event,
    id,
    account,
    isAllDay: false,
    attendees: [],
  })),
  deleteEvent: vi.fn(async () => undefined),
});

describe("CalendarService", () => {
  it("validates ranges before calling a provider", async () => {
    const connector = calendar("a");
    const registry = { getCalendarConnectors: () => [connector] } as unknown as ConnectorRegistry;
    const service = new CalendarService(registry);
    await expect(
      service.create({ subject: "x", start: "2026-01-01T12:00:00Z", end: "2026-01-01T11:00:00Z" }),
    ).rejects.toThrow(/start must be before end/);
    expect(connector.createEvent).not.toHaveBeenCalled();
  });

  it("routes mutations to the requested writable account", async () => {
    const first = calendar("first");
    const second = calendar("second");
    const registry = {
      getCalendarConnectors: () => [first, second],
    } as unknown as ConnectorRegistry;
    await new CalendarService(registry).delete("event", undefined, "second");
    expect(first.deleteEvent).not.toHaveBeenCalled();
    expect(second.deleteEvent).toHaveBeenCalledWith("event");
  });
});

describe("CalendarService write targets", () => {
  it("refuses a mutation without an account instead of using the first calendar", async () => {
    const first = calendar("first");
    const readOnly = calendar("shared", true);
    const registry = {
      getCalendarConnectors: () => [first, readOnly],
    } as unknown as ConnectorRegistry;
    const service = new CalendarService(registry);
    await expect(
      service.create({ subject: "x", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }),
    ).rejects.toThrow("account is required for calendar writes. Available: first.");
    await expect(service.delete("event", undefined, "shared")).rejects.toThrow(
      /No calendar connector for account "shared"/,
    );
    expect(first.createEvent).not.toHaveBeenCalled();
    expect(readOnly.deleteEvent).not.toHaveBeenCalled();
  });
});

describe("MessengerService", () => {
  it("scopes account routing through the requested role", async () => {
    const connector: MessengerConnector = {
      account: "work",
      platform: "test",
      listConversations: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };
    const getMessengerConnectors = vi.fn(() => [connector]);
    const registry = { getMessengerConnectors } as unknown as ConnectorRegistry;
    await new MessengerService(registry).send("conversation", "work", "hello", "role-a");
    expect(getMessengerConnectors).toHaveBeenCalledWith("role-a", "write");
    expect(connector.sendMessage).toHaveBeenCalledWith("conversation", "hello");
  });
});
