import { describe, expect, it } from "vitest";
import type { ConfigManager } from "../src/config/config-manager.js";
import { CONNECTOR_CREDENTIAL_REF_PATTERN } from "../src/config/index.js";
import { ConnectorRegistry } from "../src/connectors/index.js";
import { parseAppConfig } from "../src/config/schema.js";
import { RolePolicyService } from "../src/config/role-policy.js";
import type { ConnectorConfig } from "../src/types/index.js";

const withBooking = (booking: Partial<ConnectorConfig>[], policy?: Record<string, unknown>) =>
  parseAppConfig({
    roles: [
      {
        id: "work",
        name: "Work",
        weeklyHours: 40,
        connectors: { booking },
        ...(policy ? { policy } : {}),
      },
    ],
  });

describe("booking connector configuration", () => {
  it("accepts an anny admin connector with token reference and organization", () => {
    const config = withBooking([
      {
        id: "anny",
        type: "anny",
        account: "example-org",
        url: "https://b.anny.eu",
        organization: "11111111-2222-4333-8444-555555555555",
        credentialRef: "connector/work/booking/anny.a1b2c3",
      },
    ]);
    expect(config.roles[0]?.connectors.booking?.[0]?.type).toBe("anny");
  });

  it("accepts a per-user anny-oauth connector for customers and admins", () => {
    for (const access of ["customer", "admin"] as const) {
      const config = withBooking([
        {
          id: "anny",
          type: "anny-oauth",
          account: "example-org",
          clientId: "eule",
          organization: "example-org",
          access,
        },
      ]);
      expect(config.roles[0]?.connectors.booking?.[0]?.access).toBe(access);
    }
  });

  it("accepts anny-oauth without a client ID and offers it for sign-in", () => {
    const config = withBooking([
      { id: "anny", type: "anny-oauth", account: "example-org", url: "https://b.anny.eu" },
      { id: "issued", type: "anny-oauth", account: "example-org", clientId: "from-anny" },
    ]);
    const registry = new ConnectorRegistry({ get: () => config } as unknown as ConfigManager);
    expect(registry.getBookingSignInTargets("work")).toEqual([
      {
        role: "work",
        connectorId: "anny",
        account: "example-org",
        key: "work/anny",
        baseUrl: "https://b.anny.eu",
      },
      {
        role: "work",
        connectorId: "issued",
        account: "example-org",
        key: "work/issued",
        clientId: "from-anny",
      },
    ]);
  });

  it.each([
    [{ type: "anny", access: "customer" }, /needs type "anny-oauth"/],
    [{ type: "anny-oauth", clientId: "c", token: "t" }, /does not use a local credential/],
    [{ type: "anny", url: "http://b.anny.co" }, /https/],
    [{ type: "paperless", url: "https://p.example.com" }, /does not support domain "booking"/],
    [{ type: "anny", clientId: "c" }, /does not support "clientId"/],
    [{ type: "anny", host: "x" }, /does not support "host"/],
  ] as const)("rejects %o", (connector, message) => {
    expect(() => withBooking([{ id: "anny", account: "a", ...connector }])).toThrow(message);
  });

  it("rejects booking connectors in other domains", () => {
    expect(() =>
      parseAppConfig({
        roles: [
          {
            id: "work",
            name: "Work",
            weeklyHours: 1,
            connectors: { documents: [{ id: "a", type: "anny", account: "a" }] },
          },
        ],
      }),
    ).toThrow(/does not support domain "documents"/);
  });

  it("scopes booking credentials and honors read-only roles", () => {
    expect(CONNECTOR_CREDENTIAL_REF_PATTERN.test("connector/work/booking/anny.a1b2")).toBe(true);
    const config = withBooking([{ id: "anny", type: "anny", account: "a" }], { readOnly: true });
    const policy = new RolePolicyService(() => config);
    expect(policy.select("work", "booking", "read")).toHaveLength(1);
    expect(policy.select("work", "booking", "write")).toHaveLength(0);
  });
});
