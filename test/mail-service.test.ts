import { describe, expect, it, vi } from "vitest";
import { MailService, parseRecipients } from "../src/services/mail-service.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import type { MailConnector } from "../src/types/index.js";

function connector(): MailConnector {
  return {
    account: "sender@example.com",
    tier: "test",
    signature: "<p>Signature</p>",
    listMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => ({
      id: "1",
      account: "sender@example.com",
      subject: "s",
      from: "a",
      to: [],
      receivedAt: "",
      snippet: "",
      isRead: true,
      body: "",
      bodyType: "text",
      attachments: [],
    })),
    searchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({})),
    replyToMessage: vi.fn(async () => ({})),
    forwardMessage: vi.fn(async () => ({})),
    downloadAttachment: vi.fn(async () => Buffer.alloc(0)),
    markRead: vi.fn(async () => undefined),
    moveMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
}

function service(mail: MailConnector): MailService {
  return new MailService({
    getMailConnectors: () => [mail],
    getMailConnectorForAccount: () => mail,
  } as unknown as ConnectorRegistry);
}

describe("mail recipient validation", () => {
  it("normalizes valid addresses and rejects injection or malformed addresses", () => {
    expect(parseRecipients(" a@example.com, b@example.com ", true)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(() => parseRecipients("bad", true)).toThrow(/Invalid email/);
    expect(() => parseRecipients("a@example.com\nBcc: x@example.com", true)).toThrow();
  });
});

describe("MailService commands", () => {
  it("deduplicates concurrent sends with the same idempotency key", async () => {
    const mail = connector();
    const instance = service(mail);
    const input = {
      to: "to@example.com",
      subject: "Hello",
      body: "Body",
      account: "sender@example.com",
      idempotencyKey: "request-123",
    };
    await Promise.all([instance.send(input), instance.send(input)]);
    expect(mail.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an idempotency key for a different command", async () => {
    const instance = service(connector());
    await instance.send({
      to: "to@example.com",
      body: "First",
      account: "sender@example.com",
      idempotencyKey: "request-456",
    });
    await expect(
      instance.send({
        to: "other@example.com",
        body: "Different",
        account: "sender@example.com",
        idempotencyKey: "request-456",
      }),
    ).rejects.toThrow(/different mail command/);
  });

  it("restores signature state after a signature-free send", async () => {
    const mail = connector();
    await service(mail).send({
      to: "to@example.com",
      body: "Body",
      account: "sender@example.com",
      signature: false,
    });
    expect(mail.signature).toBe("<p>Signature</p>");
  });

  it("refuses to send or draft without a sender account", async () => {
    const mail = connector();
    mail.createDraft = vi.fn(async () => {
      throw new Error("must not be reached");
    });
    const instance = service(mail);
    await expect(instance.send({ to: "to@example.com", body: "Body" })).rejects.toThrow(
      "account is required for mail writes. Available: sender@example.com.",
    );
    await expect(instance.draft({ to: "to@example.com", body: "Body" })).rejects.toThrow(
      /account is required for mail draft writes/,
    );
    expect(mail.sendMessage).not.toHaveBeenCalled();
    expect(mail.createDraft).not.toHaveBeenCalled();
  });

  it("rejects an update with no action", async () => {
    await expect(
      service(connector()).update(["id"], "sender@example.com", undefined, {}),
    ).rejects.toThrow(/one update action/);
  });

  it("expires successful draft-submission idempotency entries", async () => {
    vi.useFakeTimers();
    try {
      const mail = connector();
      mail.sendDraft = vi.fn(async () => ({}));
      const instance = service(mail);
      await instance.sendDraft("draft-1", mail.account, undefined, "request-1");
      await instance.sendDraft("draft-1", mail.account, undefined, "request-1");
      expect(mail.sendDraft).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(24 * 60 * 60 * 1_000 + 1);
      await instance.sendDraft("draft-1", mail.account, undefined, "request-1");
      expect(mail.sendDraft).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bulk mail_update", () => {
  function summarising(): MailConnector {
    const mail = connector();
    mail.getSummaries = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => ({
        id,
        account: "sender@example.com",
        subject: `Subject ${id}`,
        from: `sender${id}@example.com`,
        to: [],
        receivedAt: "",
        snippet: "",
        isRead: false,
      })),
    );
    return mail;
  }

  it("applies one action to every id and reports subject and sender per message", async () => {
    const mail = summarising();
    const outcomes = await service(mail).update(["1", "2", "3"], "sender@example.com", undefined, {
      delete: true,
    });
    expect(mail.deleteMessage).toHaveBeenCalledTimes(3);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toMatchObject({
      id: "1",
      subject: "Subject 1",
      from: "sender1@example.com",
      actions: ["deleted"],
    });
  });

  it("reads summaries BEFORE mutating, since a deleted id no longer resolves", async () => {
    const order: string[] = [];
    const mail = connector();
    mail.getSummaries = vi.fn(async (ids: readonly string[]) => {
      order.push("summaries");
      return ids.map((id) => ({
        id,
        account: "sender@example.com",
        subject: "s",
        from: "f",
        to: [],
        receivedAt: "",
        snippet: "",
        isRead: false,
      }));
    });
    mail.deleteMessage = vi.fn(async () => {
      order.push("delete");
    });
    await service(mail).update(["1", "2"], "sender@example.com", undefined, { delete: true });
    expect(order).toEqual(["summaries", "delete", "delete"]);
  });

  it("keeps going when one id fails and reports that id specifically", async () => {
    const mail = summarising();
    mail.deleteMessage = vi.fn(async (id: string) => {
      if (id === "2") throw new Error("not found");
    });
    const outcomes = await service(mail).update(["1", "2", "3"], "sender@example.com", undefined, {
      delete: true,
    });
    expect(outcomes.filter((o) => o.error)).toHaveLength(1);
    expect(outcomes[1]).toMatchObject({ id: "2", error: "not found" });
    // The failure must not swallow the successful siblings.
    expect(outcomes.filter((o) => !o.error).map((o) => o.id)).toEqual(["1", "3"]);
  });

  it("still performs the action when the connector cannot supply summaries", async () => {
    const mail = connector();
    delete mail.getSummaries;
    const outcomes = await service(mail).update(["1"], "sender@example.com", undefined, {
      delete: true,
    });
    expect(mail.deleteMessage).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({ id: "1", actions: ["deleted"], subject: undefined });
  });

  it("does not let a failing summary lookup block the action", async () => {
    const mail = connector();
    mail.getSummaries = vi.fn(async () => {
      throw new Error("metadata unavailable");
    });
    const outcomes = await service(mail).update(["1"], "sender@example.com", undefined, {
      delete: true,
    });
    expect(outcomes[0]?.actions).toEqual(["deleted"]);
  });

  it("refuses an oversized batch and an empty one", async () => {
    const mail = summarising();
    const many = Array.from({ length: 201 }, (_, i) => String(i));
    await expect(
      service(mail).update(many, "sender@example.com", undefined, { delete: true }),
    ).rejects.toThrow(/At most 200/);
    await expect(
      service(mail).update([], "sender@example.com", undefined, { delete: true }),
    ).rejects.toThrow(/at least one message id/i);
  });
});
