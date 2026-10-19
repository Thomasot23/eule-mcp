import { runWithoutExecutionContext } from "../../utils/execution-context.js";

/** Single-flight, short-lived lookup cache, including a brief failure backoff. */
export class LookupCache<T> {
  private pending?: Promise<T>;
  private expiresAt = 0;

  get(load: () => Promise<T>): Promise<T> {
    if (this.pending && Date.now() < this.expiresAt) return this.pending;
    // Install the promise before starting work so every concurrent caller shares it.
    const pending = Promise.resolve().then(() => runWithoutExecutionContext(load));
    this.pending = pending;
    this.expiresAt = Infinity;
    void pending.then(
      () => {
        this.expire(pending, 60_000);
      },
      () => {
        this.expire(pending, 5_000);
      },
    );
    return pending;
  }

  invalidate(): void {
    this.pending = undefined;
    this.expiresAt = 0;
  }

  private expire(pending: Promise<T>, ttl: number): void {
    // An older request must not repopulate a cache invalidated by a write.
    if (this.pending === pending) this.expiresAt = Date.now() + ttl;
  }
}
