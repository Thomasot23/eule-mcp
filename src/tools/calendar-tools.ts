import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalendarService } from "../services/calendar-service.js";
import type { CalendarEvent } from "../types/index.js";
import { executeTool, textResult } from "./tool-runtime.js";

export const calendarDateTimeSchema = z.union([
  z.iso.datetime({ offset: true, local: true }),
  z.iso.datetime({ offset: true, local: true, precision: -1 }),
]);
const renderEvent = (event: CalendarEvent): string => {
  const location = event.location ? ` 📍 ${event.location}` : "";
  if (event.isAllDay) return `${event.start.slice(0, 10)} (all day) | ${event.subject}${location}`;
  const attendees = event.attendees.length ? ` 👥 ${String(event.attendees.length)}` : "";
  return `${event.start.slice(0, 16).replace("T", " ")}–${event.end.slice(11, 16)} | ${event.subject}${location}${attendees}`;
};

export function registerCalendarTools(server: McpServer, calendars: CalendarService): void {
  server.registerTool(
    "calendar_list",
    {
      description: "List upcoming calendar events",
      inputSchema: {
        role: z.string().optional(),
        days: z.number().int().min(1).max(365).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ role, days }) =>
      executeTool("calendar_list", async () => {
        const start = new Date();
        const end = new Date(start);
        end.setDate(end.getDate() + (days ?? 7));
        const result = await calendars.events(start.toISOString(), end.toISOString(), role);
        return textResult(
          [
            ...result.events.map(renderEvent),
            ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n") || "No events found.",
        );
      }),
  );
  server.registerTool(
    "calendar_today",
    {
      description: "Show today's schedule",
      inputSchema: { role: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ role }) =>
      executeTool("calendar_today", async () => {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const result = await calendars.events(start.toISOString(), end.toISOString(), role);
        if (!result.events.length && !result.failures.length)
          return textResult("📅 No events today.");
        return textResult(
          `📅 Today (${String(result.events.length)} events):\n\n${[...result.events.map(renderEvent), ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`)].join("\n")}`,
        );
      }),
  );
  server.registerTool(
    "calendar_calendars",
    {
      description: "List available calendars",
      inputSchema: { role: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ role }) =>
      executeTool("calendar_calendars", async () => {
        const result = await calendars.calendars(role);
        return textResult(
          [
            ...result.calendars.map(
              (c) => `[${c.account}] ${c.name}${c.isDefault ? " (default)" : ""}\n  ID: ${c.id}`,
            ),
            ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n\n") || "No calendars found.",
        );
      }),
  );
  const eventInput = {
    subject: z.string().trim().min(1).max(500),
    start: calendarDateTimeSchema,
    end: calendarDateTimeSchema,
    location: z.string().max(1000).optional(),
    body: z.string().max(100_000).optional(),
    attendees: z.array(z.email()).max(500).optional(),
    calendarId: z.string().optional(),
    role: z.string().optional(),
    account: z.string().min(1).describe("Account to act on (see account_list)"),
  };
  server.registerTool(
    "calendar_create",
    {
      description: "Create a calendar event",
      inputSchema: eventInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ role, account, ...event }) =>
      executeTool("calendar_create", async () => {
        const created = await calendars.create(event, role, account);
        return textResult(`📅 Event created: ${created.subject} (${created.start.slice(0, 16)})`);
      }),
  );
  server.registerTool(
    "calendar_update",
    {
      description: "Update a calendar event",
      inputSchema: {
        id: z.string(),
        subject: z.string().trim().min(1).max(500).optional(),
        start: calendarDateTimeSchema.optional(),
        end: calendarDateTimeSchema.optional(),
        location: z.string().max(1000).optional(),
        role: z.string().optional(),
        account: z.string().min(1).describe("Account to act on (see account_list)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, role, account, ...updates }) =>
      executeTool("calendar_update", async () =>
        textResult(
          `📅 Event updated: ${(await calendars.update(id, updates, role, account)).subject}`,
        ),
      ),
  );
  server.registerTool(
    "calendar_delete",
    {
      description: "Delete a calendar event",
      inputSchema: {
        id: z.string(),
        role: z.string().optional(),
        account: z.string().min(1).describe("Account holding the event (see account_list)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, role, account }) =>
      executeTool("calendar_delete", async () => {
        await calendars.delete(id, role, account);
        return textResult("📅 Event deleted.");
      }),
  );
}
