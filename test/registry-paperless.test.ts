import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import type {
  AppConfig,
  ConnectorConfig,
  DocumentConnector,
  RoleConfig,
} from "../src/types/index.js";

const appConfig = (roles: RoleConfig[]): AppConfig =>
  ({
    language: "en",
    oauth: { clientId: "test-client", tenant: "common", apiVersion: "v1" },
    roles,
  }) as AppConfig;

const role = (
  id: string,
  documents: ConnectorConfig[],
  policy?: RoleConfig["policy"],
): RoleConfig => ({
  id,
  name: id,
  weeklyHours: 40,
  connectors: { documents },
  ...(policy ? { policy } : {}),
});

const paperless = (
  id: string,
  account: string,
  url: string,
  overrides: Partial<ConnectorConfig> = {},
): ConnectorConfig => ({
  id,
  type: "paperless",
  account,
  url,
  token: "configured-placeholder",
  ...overrides,
});

const paperlessDetails = (connector: DocumentConnector) =>
  connector as unknown as { account: string; baseUrl: string; token: string };

describe("ConnectorRegistry Paperless instance reuse", () => {
  let config: AppConfig;
  let credential: string;
  let resolveCredential: ReturnType<typeof vi.fn>;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    credential = "synthetic-token-1";
    config = appConfig([
      role("personal", [paperless("papers", "personal-account", "https://paperless.example")]),
    ]);
    resolveCredential = vi.fn(() => credential);
    registry = new ConnectorRegistry(
      { get: () => config } as never,
      { connector: resolveCredential } as never,
    );
  });

  it("reuses one instance across calls and access modes while resolving credentials each time", () => {
    const firstRead = registry.getDocumentConnectors("personal", "read")[0];
    const secondRead = registry.getDocumentConnectors("personal", "read")[0];
    const write = registry.getDocumentConnectors("personal", "write")[0];

    expect(firstRead).toBeDefined();
    expect(secondRead).toBe(firstRead);
    expect(write).toBe(firstRead);
    expect(resolveCredential).toHaveBeenCalledTimes(3);
    expect(paperlessDetails(firstRead!).token).toBe("synthetic-token-1");
  });

  it("keeps instances isolated by role and connector ID, even for matching IDs", () => {
    config = appConfig([
      role("work", [
        paperless("primary", "work-account", "https://work.example"),
        paperless("archive", "archive-account", "https://archive.example"),
      ]),
      role("personal", [paperless("primary", "personal-account", "https://personal.example")]),
    ]);

    const work = registry.getDocumentConnectors("work");
    const personal = registry.getDocumentConnectors("personal");
    const workAgain = registry.getDocumentConnectors("work");

    expect(work).toHaveLength(2);
    expect(personal).toHaveLength(1);
    expect(workAgain[0]).toBe(work[0]);
    expect(workAgain[1]).toBe(work[1]);
    expect(work[0]).not.toBe(work[1]);
    expect(work[0]).not.toBe(personal[0]);
    expect(paperlessDetails(work[0]!).account).toBe("work-account");
    expect(paperlessDetails(work[0]!).baseUrl).toBe("https://work.example");
    expect(paperlessDetails(work[1]!).account).toBe("archive-account");
    expect(paperlessDetails(work[1]!).baseUrl).toBe("https://archive.example");
    expect(paperlessDetails(personal[0]!).account).toBe("personal-account");
    expect(paperlessDetails(personal[0]!).baseUrl).toBe("https://personal.example");
  });

  it("replaces an instance when the resolved credential rotates", () => {
    const first = registry.getDocumentConnectors("personal")[0];
    credential = "synthetic-token-2";
    const rotated = registry.getDocumentConnectors("personal")[0];

    expect(rotated).not.toBe(first);
    expect(paperlessDetails(first!).token).toBe("synthetic-token-1");
    expect(paperlessDetails(rotated!).token).toBe("synthetic-token-2");
    expect(resolveCredential).toHaveBeenCalledTimes(2);
  });

  it("replaces instances after account, URL, or other connector configuration changes", () => {
    const original = registry.getDocumentConnectors("personal")[0];
    const changedUrl = paperless("papers", "personal-account", "https://paperless-new.example");
    config = appConfig([role("personal", [changedUrl])]);
    const afterUrlChange = registry.getDocumentConnectors("personal")[0];

    const changedAccount = paperless("papers", "new-account", "https://paperless-new.example");
    config = appConfig([role("personal", [changedAccount])]);
    const afterAccountChange = registry.getDocumentConnectors("personal")[0];

    const changedCredentialConfig = paperless(
      "papers",
      "new-account",
      "https://paperless-new.example",
      {
        credentialRef: "connector/personal/documents/papers",
      },
    );
    config = appConfig([role("personal", [changedCredentialConfig])]);
    const afterConfigChange = registry.getDocumentConnectors("personal")[0];

    expect(afterUrlChange).not.toBe(original);
    expect(paperlessDetails(afterUrlChange!).baseUrl).toBe("https://paperless-new.example");
    expect(afterAccountChange).not.toBe(afterUrlChange);
    expect(paperlessDetails(afterAccountChange!).account).toBe("new-account");
    expect(afterConfigChange).not.toBe(afterAccountChange);
    expect(resolveCredential).toHaveBeenCalledTimes(4);
  });

  it("drops removed connectors and does not resurrect their cached instance", () => {
    const original = registry.getDocumentConnectors("personal")[0];
    config = appConfig([role("personal", [])]);
    expect(registry.getDocumentConnectors("personal")).toEqual([]);

    config = appConfig([
      role("personal", [paperless("papers", "personal-account", "https://paperless.example")]),
    ]);
    const restored = registry.getDocumentConnectors("personal")[0];

    expect(restored).not.toBe(original);
    expect(resolveCredential).toHaveBeenCalledTimes(2);
  });

  it("reapplies read-only policy to a warm instance and honors a disabled role", () => {
    const switchable = role("switchable", [
      paperless("switchable", "switchable-account", "https://switchable.example"),
    ]);
    config = appConfig([
      role("read-only", [paperless("readonly", "readonly-account", "https://readonly.example")], {
        readOnly: true,
      }),
      switchable,
    ]);

    const readOnlyRead = registry.getDocumentConnectors("read-only", "read")[0];
    expect(registry.getDocumentConnectors("read-only", "write")).toEqual([]);
    expect(registry.getDocumentConnectors("read-only", "read")[0]).toBe(readOnlyRead);

    const enabled = registry.getDocumentConnectors("switchable", "read")[0];
    (switchable as { policy?: RoleConfig["policy"] }).policy = { enabled: false };
    expect(registry.getDocumentConnectors("switchable", "read")).toEqual([]);
    expect(registry.getDocumentConnectors("switchable", "write")).toEqual([]);

    (switchable as { policy?: RoleConfig["policy"] }).policy = undefined;
    expect(registry.getDocumentConnectors("switchable", "read")[0]).toBe(enabled);
  });
});
