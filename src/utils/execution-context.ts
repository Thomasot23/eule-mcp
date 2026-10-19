import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionContext {
  readonly correlationId: string;
  readonly operation: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}

const store = new AsyncLocalStorage<ExecutionContext>();

export function currentExecutionContext(): ExecutionContext | undefined {
  return store.getStore();
}

export function currentExecutionSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

export function runWithExecutionContext<T>(context: ExecutionContext, callback: () => T): T {
  return store.run(context, callback);
}

/** Shared work must use its own deadline, not one subscriber's cancellation. */
export function runWithoutExecutionContext<T>(callback: () => T): T {
  return store.exit(callback);
}

/** Fetch that composes a caller-provided signal with the active operation signal. */
export function fetchWithExecutionContext(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const active = currentExecutionSignal();
  const signal =
    active && init.signal ? AbortSignal.any([active, init.signal]) : (active ?? init.signal);
  return globalThis.fetch(input, { ...init, signal });
}
