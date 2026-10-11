import { describe, expect, it } from "vitest";
import {
  collectProviderResults,
  requireConnector,
  selectConnector,
} from "../src/services/provider-orchestration.js";

describe("provider orchestration", () => {
  it("returns successful values and explicit per-account failures", async () => {
    const result = await collectProviderResults(
      [{ account: "ok" }, { account: "down" }],
      async (connector) => {
        if (connector.account === "down") throw new Error("timeout");
        return [1, 2];
      },
    );
    expect(result.values).toEqual([1, 2]);
    expect(result.failures).toEqual([{ account: "down", message: "timeout" }]);
  });

  it("selects only the requested capable account", () => {
    const connectors = [
      { account: "a", writable: false },
      { account: "b", writable: true },
    ];
    expect(selectConnector(connectors, undefined, (item) => item.writable)?.account).toBe("b");
    expect(selectConnector(connectors, "a", (item) => item.writable)).toBeUndefined();
  });

  it("matches account identifiers without case sensitivity", () => {
    const connectors = [{ account: "User@Example.COM" }];
    expect(selectConnector(connectors, "user@example.com")).toBe(connectors[0]);
  });

  it("bounds provider concurrency", async () => {
    let active = 0;
    let peak = 0;
    await collectProviderResults(
      Array.from({ length: 8 }, (_, index) => ({ account: String(index) })),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return [];
      },
      2,
    );
    expect(peak).toBe(2);
  });
});

describe("requireConnector", () => {
  const connectors = [
    { account: "a@example.com", writable: false },
    { account: "b@example.com", writable: true },
    { account: "c@example.com", writable: true },
  ];

  it("refuses a write without an account and lists the eligible accounts", () => {
    expect(() => requireConnector(connectors, undefined, "mail", (c) => c.writable)).toThrow(
      "account is required for mail writes. Available: b@example.com, c@example.com.",
    );
    expect(() => requireConnector(connectors, "  ", "mail")).toThrow(/account is required/);
  });

  it("refuses an account that is unknown or not eligible", () => {
    expect(() => requireConnector(connectors, "a@example.com", "mail", (c) => c.writable)).toThrow(
      'No mail connector for account "a@example.com". Available: b@example.com, c@example.com.',
    );
    expect(() => requireConnector([], "x@example.com", "task")).toThrow(
      /No task account is available/,
    );
  });

  it("returns the named account, case-insensitively", () => {
    expect(requireConnector(connectors, "C@Example.com", "mail").account).toBe("c@example.com");
  });
});
