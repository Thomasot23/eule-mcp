import type { ConnectorRegistry } from "../connectors/index.js";
import type {
  RemoteTask,
  RemoteTaskInput,
  RemoteTaskUpdate,
  TaskListInfo,
} from "../types/index.js";
import {
  collectProviderResults,
  requireConnector,
  type ProviderFailure,
} from "./provider-orchestration.js";

export interface TaskListQuery {
  readonly role?: string;
  readonly account?: string;
  readonly listId?: string;
  readonly includeCompleted?: boolean;
  readonly limit?: number;
}

export interface TaskReadResult {
  readonly tasks: RemoteTask[];
  readonly failures: ProviderFailure[];
}

/**
 * Application boundary for task use cases. Tasks live in the user's own system
 * (Microsoft To Do, Apple Reminders, Nextcloud Tasks) rather than in a private
 * store, so every read fans out across the configured task connectors.
 */
export class TaskService {
  constructor(private readonly registry: ConnectorRegistry) {}

  async lists(role?: string): Promise<{ lists: TaskListInfo[]; failures: ProviderFailure[] }> {
    const result = await collectProviderResults(
      this.registry.getTaskConnectors(role),
      (connector) => connector.listTaskLists(),
    );
    return { lists: result.values, failures: result.failures };
  }

  async list(query: TaskListQuery = {}): Promise<TaskReadResult> {
    const connectors = this.registry
      .getTaskConnectors(query.role)
      .filter((connector) => !query.account || connector.account === query.account);
    const result = await collectProviderResults(connectors, (connector) =>
      connector.listTasks({
        listId: query.listId,
        includeCompleted: query.includeCompleted,
        limit: query.limit,
      }),
    );
    return { tasks: sortTasks(result.values), failures: result.failures };
  }

  /**
   * Neither To Do nor CalDAV offers a useful server-side text search for tasks,
   * so this filters what the providers return. `limit` therefore bounds the
   * matches, not the rows scanned.
   */
  async search(
    query: string,
    opts: { role?: string; includeCompleted?: boolean; limit?: number } = {},
  ): Promise<TaskReadResult> {
    const needle = query.toLowerCase();
    const result = await collectProviderResults(
      this.registry.getTaskConnectors(opts.role),
      (connector) => connector.listTasks({ includeCompleted: opts.includeCompleted, limit: 200 }),
    );
    const matches = result.values.filter((task) =>
      `${task.title} ${task.notes ?? ""}`.toLowerCase().includes(needle),
    );
    return {
      tasks: sortTasks(matches).slice(0, opts.limit ?? 50),
      failures: result.failures,
    };
  }

  async add(
    input: RemoteTaskInput & { role?: string; account?: string },
  ): Promise<{ task: RemoteTask; account: string; tier: string }> {
    const target = requireConnector(
      this.registry.getTaskConnectors(input.role, "write"),
      input.account,
      "task",
      (connector) => !connector.readOnly,
    );
    const task = await target.createTask({
      title: input.title,
      notes: input.notes,
      due: input.due,
      importance: input.importance,
      listId: input.listId,
    });
    return { task, account: target.account, tier: target.tier };
  }

  async update(id: string, updates: RemoteTaskUpdate, role?: string): Promise<RemoteTask> {
    return this.onOwner(id, role, (connector) => connector.updateTask(id, updates));
  }

  async complete(id: string, role?: string): Promise<RemoteTask> {
    return this.onOwner(id, role, (connector) => connector.updateTask(id, { completed: true }));
  }

  async remove(id: string, role?: string): Promise<void> {
    return this.onOwner(id, role, (connector) => connector.deleteTask(id));
  }

  /**
   * Runs a mutation against the connector that actually owns `id`.
   *
   * Task ids are provider-specific and opaque: a CalDAV id is the object URL, a
   * Graph id is `<listId>/<taskId>`. The id shape narrows the candidates, but
   * several accounts can share a shape, so the remaining ones are tried in
   * order. A connector that does not own the id rejects before mutating
   * anything, which makes the retry safe rather than destructive.
   */
  private async onOwner<T>(
    id: string,
    role: string | undefined,
    operation: (
      connector: ReturnType<ConnectorRegistry["getTaskConnectors"]>[number],
    ) => Promise<T>,
  ): Promise<T> {
    const isUrl = /^https?:\/\//i.test(id);
    const candidates = this.registry
      .getTaskConnectors(role, "write")
      .filter((connector) => (isUrl ? connector.tier === "caldav" : connector.tier !== "caldav"));
    if (candidates.length === 0) throw new Error(`No task connector can handle id "${id}"`);

    let lastError: unknown;
    for (const connector of candidates) {
      try {
        return await operation(connector);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Open first, then by due date (undated last), then by title. */
function sortTasks(tasks: RemoteTask[]): RemoteTask[] {
  return [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    }
    return a.title.localeCompare(b.title);
  });
}
