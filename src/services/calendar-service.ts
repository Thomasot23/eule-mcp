import type { ConnectorRegistry } from "../connectors/index.js";
import type { CalendarEvent, CalendarEventInput, CalendarInfo } from "../types/index.js";
import {
  collectProviderResults,
  requireConnector,
  type ProviderFailure,
} from "./provider-orchestration.js";

function assertDate(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`${field} must be a valid ISO 8601 date-time`);
}
function validateRange(start?: string, end?: string): void {
  if (start) assertDate(start, "start");
  if (end) assertDate(end, "end");
  if (start && end && Date.parse(start) >= Date.parse(end))
    throw new Error("Event start must be before end");
}

export class CalendarService {
  constructor(private readonly registry: ConnectorRegistry) {}
  async events(
    start: string,
    end: string,
    role?: string,
  ): Promise<{ events: CalendarEvent[]; failures: ProviderFailure[] }> {
    validateRange(start, end);
    const result = await collectProviderResults(this.registry.getCalendarConnectors(role), (c) =>
      c.listEvents(start, end),
    );
    result.values.sort((a, b) => a.start.localeCompare(b.start));
    return { events: result.values, failures: result.failures };
  }
  async calendars(
    role?: string,
  ): Promise<{ calendars: CalendarInfo[]; failures: ProviderFailure[] }> {
    const result = await collectProviderResults(this.registry.getCalendarConnectors(role), (c) =>
      c.listCalendars(),
    );
    return { calendars: result.values, failures: result.failures };
  }
  async create(event: CalendarEventInput, role?: string, account?: string): Promise<CalendarEvent> {
    validateRange(event.start, event.end);
    const connector = requireConnector(
      this.registry.getCalendarConnectors(role, "write"),
      account,
      "calendar",
      (c) => !c.readOnly,
    );
    return connector.createEvent(event);
  }
  async update(
    id: string,
    updates: Partial<CalendarEventInput>,
    role?: string,
    account?: string,
  ): Promise<CalendarEvent> {
    validateRange(updates.start, updates.end);
    const connector = requireConnector(
      this.registry.getCalendarConnectors(role, "write"),
      account,
      "calendar",
      (c) => !c.readOnly,
    );
    return connector.updateEvent(id, updates);
  }
  async delete(id: string, role?: string, account?: string): Promise<void> {
    const connector = requireConnector(
      this.registry.getCalendarConnectors(role, "write"),
      account,
      "calendar",
      (c) => !c.readOnly,
    );
    await connector.deleteEvent(id);
  }
}
