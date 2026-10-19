import { describe, expect, it, vi } from "vitest";
import { LookupCache } from "../src/providers/paperless/lookup-cache.js";

describe("Paperless cache invalidation races", () => {
  it("does not let an in-flight pre-write request repopulate or expire the new cache", async () => {
    const cache = new LookupCache<string[]>();
    let finishOld!: (value: string[]) => void;
    const old = cache.get(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    await Promise.resolve();
    cache.invalidate();
    const loadNew = vi.fn(async () => ["new"]);
    const fresh = cache.get(loadNew);
    await expect(fresh).resolves.toEqual(["new"]);
    finishOld(["old"]);
    await expect(old).resolves.toEqual(["old"]);
    expect(cache.get(loadNew)).toBe(fresh);
    expect(loadNew).toHaveBeenCalledTimes(1);
  });

  it("shares a rejected promise too, preventing per-document retry storms", async () => {
    const cache = new LookupCache<string[]>();
    const load = vi.fn(async () => {
      throw new Error("offline");
    });
    const first = cache.get(load);
    expect(cache.get(load)).toBe(first);
    await expect(first).rejects.toThrow("offline");
    expect(cache.get(load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
