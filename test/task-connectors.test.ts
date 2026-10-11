import { describe, it, expect, vi } from "vitest";
import { applyComponentUpdates, readComponentProp } from "../src/providers/caldav/ics.js";
import { TaskService } from "../src/services/task-service.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import type { RemoteTask, TaskConnector } from "../src/types/index.js";

// A VTODO with a nested VALARM that has its own SUMMARY/DESCRIPTION, so the
// component scoping is actually exercised.
const VTODO = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTODO",
  "UID:task-1@test",
  "DTSTAMP:20260101T000000Z",
  "SUMMARY:Original task",
  "DESCRIPTION:Some notes",
  "DUE;VALUE=DATE:20260410",
  "PRIORITY:5",
  "STATUS:NEEDS-ACTION",
  "SEQUENCE:1",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "SUMMARY:Alarm summary",
  "DESCRIPTION:Reminder",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VTODO",
  "END:VCALENDAR",
].join("\r\n");

const NOW = "20260202T000000Z";

describe("VTODO in-place updates", () => {
  it("completes a task and records COMPLETED plus PERCENT-COMPLETE", () => {
    const out = applyComponentUpdates(
      VTODO,
      "VTODO",
      new Map([
        ["STATUS", "COMPLETED"],
        ["COMPLETED", NOW],
        ["PERCENT-COMPLETE", "100"],
      ]),
    );
    expect(out).toContain("STATUS:COMPLETED");
    expect(out).toContain(`COMPLETED:${NOW}`);
    expect(out).toContain("PERCENT-COMPLETE:100");
    expect(out).not.toContain("STATUS:NEEDS-ACTION");
  });

  it("reopening clears COMPLETED and PERCENT-COMPLETE", () => {
    const done = applyComponentUpdates(
      VTODO,
      "VTODO",
      new Map([
        ["STATUS", "COMPLETED"],
        ["COMPLETED", NOW],
        ["PERCENT-COMPLETE", "100"],
      ]),
    );
    const reopened = applyComponentUpdates(
      done,
      "VTODO",
      new Map<string, string | null>([
        ["STATUS", "NEEDS-ACTION"],
        ["COMPLETED", null],
        ["PERCENT-COMPLETE", null],
      ]),
    );
    expect(reopened).toContain("STATUS:NEEDS-ACTION");
    // Leaving these behind makes clients keep showing the task as done.
    expect(reopened).not.toContain("COMPLETED:");
    expect(reopened).not.toContain("PERCENT-COMPLETE:");
  });

  it("keeps a date-only DUE all-day and can switch it to a date-time", () => {
    const allDay = applyComponentUpdates(
      VTODO,
      "VTODO",
      new Map([["DUE", ";VALUE=DATE:20260501"]]),
    );
    expect(allDay).toContain("DUE;VALUE=DATE:20260501");

    const timed = applyComponentUpdates(VTODO, "VTODO", new Map([["DUE", "20260501T090000Z"]]));
    expect(timed).toContain("DUE:20260501T090000Z");
    // The old VALUE=DATE parameter must not survive a switch to a date-time.
    expect(timed).not.toContain("DUE;VALUE=DATE");
  });

  it("never rewrites the nested VALARM's own SUMMARY or DESCRIPTION", () => {
    const out = applyComponentUpdates(
      VTODO,
      "VTODO",
      new Map([
        ["SUMMARY", "Renamed"],
        ["DESCRIPTION", "New notes"],
      ]),
    );
    expect(out).toContain("SUMMARY:Renamed");
    expect(out).toContain("SUMMARY:Alarm summary");
    expect(out).toContain("DESCRIPTION:Reminder");
  });

  it("reads a component property without picking up the alarm's", () => {
    expect(readComponentProp(VTODO, "VTODO", "SUMMARY")).toBe("Original task");
    expect(readComponentProp(VTODO, "VALARM", "SUMMARY")).toBe("Alarm summary");
  });
});

function task(overrides: Partial<RemoteTask> & { id: string; title: string }): RemoteTask {
  return {
    account: "a@example.com",
    listId: "list",
    completed: false,
    ...overrides,
  } as RemoteTask;
}

/** Minimal connector stub; only what TaskService actually calls. */
function stub(tier: string, tasks: RemoteTask[], overrides: Partial<TaskConnector> = {}) {
  const connector: TaskConnector = {
    account: tasks[0]?.account ?? "a@example.com",
    tier,
    readOnly: false,
    listTaskLists: () => Promise.resolve([]),
    listTasks: () => Promise.resolve(tasks),
    createTask: () => Promise.reject(new Error("not implemented")),
    updateTask: () => Promise.reject(new Error("not implemented")),
    deleteTask: () => Promise.reject(new Error("not implemented")),
    ...overrides,
  };
  return connector;
}

function serviceWith(connectors: TaskConnector[]): TaskService {
  return new TaskService({
    getTaskConnectors: () => connectors,
  } as unknown as ConnectorRegistry);
}

describe("TaskService", () => {
  it("refuses to add a task without a target account", async () => {
    const createTask = vi.fn(() => Promise.reject(new Error("must not be reached")));
    const service = serviceWith([stub("graph", [], { createTask })]);
    await expect(service.add({ title: "Call back" })).rejects.toThrow(
      "account is required for task writes. Available: a@example.com.",
    );
    expect(createTask).not.toHaveBeenCalled();
  });

  it("sorts open tasks before completed, then by due date, then title", async () => {
    const service = serviceWith([
      stub("graph", [
        task({ id: "1", title: "Zebra", due: "2026-05-01" }),
        task({ id: "2", title: "Done", completed: true }),
        task({ id: "3", title: "Apple", due: "2026-05-01" }),
        task({ id: "4", title: "No due" }),
        task({ id: "5", title: "Early", due: "2026-01-01" }),
      ]),
    ]);
    const { tasks } = await service.list({ includeCompleted: true });
    expect(tasks.map((t) => t.title)).toEqual(["Early", "Apple", "Zebra", "No due", "Done"]);
  });

  it("reports a failing backend instead of silently returning fewer tasks", async () => {
    const service = serviceWith([
      stub("graph", [task({ id: "1", title: "Kept" })]),
      stub("caldav", [], { listTasks: () => Promise.reject(new Error("401 Unauthorized")) }),
    ]);
    const { tasks, failures } = await service.list();
    expect(tasks).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("401");
  });

  it("searches title and notes case-insensitively", async () => {
    const service = serviceWith([
      stub("graph", [
        task({ id: "1", title: "Buy milk" }),
        task({ id: "2", title: "Other", notes: "remember the MILK" }),
        task({ id: "3", title: "Unrelated" }),
      ]),
    ]);
    const { tasks } = await service.search("milk");
    expect(tasks.map((t) => t.id).sort()).toEqual(["1", "2"]);
  });

  it("routes a URL id to CalDAV and an opaque id to Graph", async () => {
    const calls: string[] = [];
    const graph = stub("graph", [], {
      updateTask: (id) => {
        calls.push(`graph:${id}`);
        return Promise.resolve(task({ id, title: "g" }));
      },
    });
    const caldav = stub("caldav", [], {
      updateTask: (id) => {
        calls.push(`caldav:${id}`);
        return Promise.resolve(task({ id, title: "c" }));
      },
    });
    const service = serviceWith([graph, caldav]);

    await service.complete("https://dav.example.com/tasks/1.ics");
    await service.complete("listid/taskid");
    expect(calls).toEqual(["caldav:https://dav.example.com/tasks/1.ics", "graph:listid/taskid"]);
  });

  it("tries the next candidate when one connector does not own the id", async () => {
    const missing = stub("caldav", [], {
      updateTask: () => Promise.reject(new Error("Task not found")),
    });
    const owner = stub("caldav", [], {
      updateTask: (id) => Promise.resolve(task({ id, title: "owned" })),
    });
    const service = serviceWith([missing, owner]);
    const result = await service.complete("https://dav.example.com/tasks/1.ics");
    expect(result.title).toBe("owned");
  });

  it("surfaces the last error when no connector owns the id", async () => {
    const service = serviceWith([
      stub("caldav", [], { updateTask: () => Promise.reject(new Error("Task not found")) }),
    ]);
    await expect(service.complete("https://dav.example.com/tasks/1.ics")).rejects.toThrow(
      /not found/i,
    );
  });
});
