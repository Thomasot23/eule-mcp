import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskService } from "../services/task-service.js";
import type { ProviderFailure } from "../services/provider-orchestration.js";
import type { RemoteTask } from "../types/index.js";
import { executeTool, textResult } from "./tool-runtime.js";

const importance = z.enum(["low", "normal", "high"]);

/** Partial reads must say so, otherwise a missing backend looks like "no tasks". */
function withFailures(text: string, failures: readonly ProviderFailure[]): string {
  if (failures.length === 0) return text;
  const notes = failures.map((f) => `  ${f.account}: ${f.message}`).join("\n");
  return `${text}\n\n⚠️ Some task backends could not be read:\n${notes}`;
}

function render(task: RemoteTask): string {
  const parts = [task.completed ? "✅" : "○", task.title];
  if (task.due) parts.push(`(due ${task.due.slice(0, 10)})`);
  if (task.importance && task.importance !== "normal") parts.push(`[${task.importance}]`);
  const where = task.listName ? `${task.listName} · ${task.account}` : task.account;
  return `${parts.join(" ")}\n   ${where}\n   id: ${task.id}`;
}

export function registerTaskTools(server: McpServer, tasks: TaskService): void {
  server.registerTool(
    "task_lists",
    {
      description: "List the available task lists across configured task backends",
      inputSchema: { role: z.string().optional().describe("Filter by role ID") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ role }, extra) =>
      executeTool(
        "task_lists",
        async () => {
          const { lists, failures } = await tasks.lists(role);
          const body =
            lists
              .map(
                (l) =>
                  `${l.name}${l.isDefault ? " (default)" : ""}\n   ${l.account}\n   id: ${l.id}`,
              )
              .join("\n\n") || "No task lists found.";
          return textResult(withFailures(body, failures));
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "task_list",
    {
      description: "List tasks from Microsoft To Do, Apple Reminders or Nextcloud Tasks",
      inputSchema: {
        role: z.string().optional().describe("Filter by role ID"),
        account: z.string().optional().describe("Limit to one account"),
        list_id: z.string().optional().describe("Limit to one task list (from task_lists)"),
        include_completed: z.boolean().optional().describe("Include completed tasks"),
        limit: z.number().int().min(1).max(200).optional().describe("Max tasks (default 100)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ role, account, list_id, include_completed, limit }, extra) =>
      executeTool(
        "task_list",
        async () => {
          const { tasks: found, failures } = await tasks.list({
            role,
            account,
            listId: list_id,
            includeCompleted: include_completed,
            limit,
          });
          const body = found.map(render).join("\n\n") || "No tasks.";
          return textResult(withFailures(body, failures));
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "task_search",
    {
      description: "Search tasks by title and notes across configured task backends",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for"),
        role: z.string().optional().describe("Filter by role ID"),
        include_completed: z.boolean().optional().describe("Include completed tasks"),
        limit: z.number().int().min(1).max(200).optional().describe("Max matches (default 50)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, role, include_completed, limit }, extra) =>
      executeTool(
        "task_search",
        async () => {
          const { tasks: found, failures } = await tasks.search(query, {
            role,
            includeCompleted: include_completed,
            limit,
          });
          const body = found.map(render).join("\n\n") || `No tasks matching "${query}".`;
          return textResult(withFailures(body, failures));
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "task_add",
    {
      description: "Create a task in the user's task system",
      inputSchema: {
        title: z.string().min(1).describe("Task title"),
        notes: z.string().optional().describe("Task details/notes"),
        due: z.string().optional().describe("Due date (YYYY-MM-DD or ISO-8601 date-time)"),
        importance: importance.optional().describe("Priority"),
        list_id: z.string().optional().describe("Target list (from task_lists)"),
        role: z.string().optional().describe("Role ID"),
        account: z.string().min(1).describe("Target account (see account_list)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title, notes, due, importance: prio, list_id, role, account }, extra) =>
      executeTool(
        "task_add",
        async () => {
          const { task, tier } = await tasks.add({
            title,
            notes,
            due,
            importance: prio,
            listId: list_id,
            role,
            account,
          });
          return textResult(`✅ Task created in ${task.listName ?? tier}\n\n${render(task)}`);
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "task_update",
    {
      description: "Update a task (title, notes, due date, priority, completion)",
      inputSchema: {
        id: z.string().min(1).describe("Task ID (from task_list or task_search)"),
        title: z.string().optional().describe("New title"),
        notes: z.string().optional().describe("New notes"),
        due: z.string().nullable().optional().describe("New due date, or null to clear it"),
        importance: importance.optional().describe("New priority"),
        completed: z.boolean().optional().describe("Mark done or reopen"),
        role: z.string().optional().describe("Role ID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, title, notes, due, importance: prio, completed, role }, extra) =>
      executeTool(
        "task_update",
        async () => {
          const task = await tasks.update(
            id,
            { title, notes, due, importance: prio, completed },
            role,
          );
          return textResult(`✅ Task updated\n\n${render(task)}`);
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "task_complete",
    {
      description: "Mark a task as done",
      inputSchema: {
        id: z.string().min(1).describe("Task ID (from task_list or task_search)"),
        role: z.string().optional().describe("Role ID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, role }, extra) =>
      executeTool(
        "task_complete",
        async () => textResult(`✅ Completed\n\n${render(await tasks.complete(id, role))}`),
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "task_delete",
    {
      description: "Delete a task permanently from the user's task system",
      inputSchema: {
        id: z.string().min(1).describe("Task ID (from task_list or task_search)"),
        role: z.string().optional().describe("Role ID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, role }, extra) =>
      executeTool(
        "task_delete",
        async () => {
          await tasks.remove(id, role);
          return textResult(`🗑️ Task deleted: ${id}`);
        },
        { signal: extra.signal },
      ),
  );
}
