import { describe, expect, it, vi } from "vitest";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import { DocumentService } from "../src/services/document-service.js";
import type { DocumentConnector } from "../src/types/index.js";

function registryWith(connectors: readonly DocumentConnector[]): ConnectorRegistry {
  return {
    getDocumentConnectors: vi.fn(() => [...connectors]),
  } as unknown as ConnectorRegistry;
}

describe("DocumentService connector semantics", () => {
  it("rejects list and search when no usable connector is configured", async () => {
    const service = new DocumentService(registryWith([]));

    await expect(service.list()).rejects.toThrow(/No usable document connector is configured/);
    await expect(service.search("invoice", "work")).rejects.toThrow(
      /No usable document connector is configured for role "work"/,
    );
  });

  it("preserves an empty successful provider response as a real empty result", async () => {
    const connector = {
      account: "paperless.example.com",
      listDocuments: vi.fn(async () => []),
      searchDocuments: vi.fn(async () => []),
    } as unknown as DocumentConnector;
    const service = new DocumentService(registryWith([connector]));

    await expect(service.list()).resolves.toEqual({ values: [], failures: [] });
    await expect(service.search("invoice")).resolves.toEqual({ values: [], failures: [] });
  });
});

describe("DocumentService write targets", () => {
  const paperless = (account: string): DocumentConnector =>
    ({
      account,
      updateDocument: vi.fn(async () => ({})),
    }) as unknown as DocumentConnector;

  it("refuses a write when several instances are writable", async () => {
    const first = paperless("first.example.com");
    const second = paperless("second.example.com");
    const service = new DocumentService(registryWith([first, second]));
    await expect(service.update(1, undefined, { title: "x" })).rejects.toThrow(
      /Several document connectors are writable \(first.example.com, second.example.com\)/,
    );
    expect(first.updateDocument).not.toHaveBeenCalled();
  });

  it("writes to the only instance the role leaves", async () => {
    const only = paperless("only.example.com");
    await new DocumentService(registryWith([only])).update(1, "work", { title: "x" });
    expect(only.updateDocument).toHaveBeenCalledWith(1, { title: "x" });
  });
});
