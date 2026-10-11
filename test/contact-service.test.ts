import { describe, expect, it, vi } from "vitest";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import type { ContactManager } from "../src/db/index.js";
import { ContactService } from "../src/services/contact-service.js";
import type { ContactConnector } from "../src/types/index.js";

function localStore(): ContactManager {
  return {
    add: vi.fn((name: string) => ({ id: 1, name })),
  } as unknown as ContactManager;
}

function addressBook(account: string): ContactConnector {
  return {
    account,
    tier: "test",
    readOnly: false,
    createContact: vi.fn(async (input: { displayName: string }) => ({
      id: "c1",
      account,
      displayName: input.displayName,
    })),
  } as unknown as ContactConnector;
}

const registryWith = (connectors: ContactConnector[]): ConnectorRegistry =>
  ({ getContactConnectors: () => connectors }) as unknown as ConnectorRegistry;

describe("ContactService.add targets", () => {
  it("refuses a remote add without an account when an address book exists", async () => {
    const book = addressBook("me@example.com");
    const local = localStore();
    const service = new ContactService(registryWith([book]), local);
    await expect(service.add({ name: "Ada" })).rejects.toThrow(
      "account is required for contact writes. Available: me@example.com.",
    );
    expect(book.createContact).not.toHaveBeenCalled();
    expect(local.add).not.toHaveBeenCalled();
  });

  it("does not fall back to the local store for an unknown account", async () => {
    const local = localStore();
    const service = new ContactService(registryWith([addressBook("me@example.com")]), local);
    await expect(service.add({ name: "Ada", account: "typo@example.com" })).rejects.toThrow(
      /No contact connector for account "typo@example.com"/,
    );
    expect(local.add).not.toHaveBeenCalled();
  });

  it("stores locally when asked or when no address book is configured", async () => {
    const local = localStore();
    const book = addressBook("me@example.com");
    await new ContactService(registryWith([book]), local).add({ name: "Ada", local: true });
    await new ContactService(registryWith([]), local).add({ name: "Grace" });
    expect(local.add).toHaveBeenCalledTimes(2);
    expect(book.createContact).not.toHaveBeenCalled();
  });

  it("adds to the named address book", async () => {
    const book = addressBook("me@example.com");
    const result = await new ContactService(registryWith([book]), localStore()).add({
      name: "Ada",
      account: "me@example.com",
    });
    expect(result).toMatchObject({ kind: "remote", account: "me@example.com" });
  });
});
