import { describe, expect, it, vi } from "vitest";
import { ConfigurationControlService } from "../src/services/configuration-control-service.js";
import type { ConfigManager } from "../src/config/index.js";
import type {
  CredentialBroker,
  CredentialState,
  OathCredentialBroker,
  OathCredentialStatus,
} from "../src/helper/credential-store.js";
import { ConfiguredCredentialResolver } from "../src/helper/configured-credential-resolver.js";
import type { AppConfig, ConnectorConfig, ConnectorKind } from "../src/types/index.js";

class FakeCredentials implements CredentialBroker {
  readonly captured: string[] = [];
  readonly removed: string[] = [];
  readonly values = new Map<string, string>();
  capture = vi.fn(async (reference: string) => {
    this.captured.push(reference);
    this.values.set(reference, "secret");
  });
  read = vi.fn((reference: string) => this.values.get(reference) ?? "secret");
  status = vi.fn((reference: string): CredentialState =>
    this.values.has(reference) ? "configured" : "missing",
  );
  remove = vi.fn((reference: string) => {
    this.removed.push(reference);
    this.values.delete(reference);
  });
}

/** A YubiKey: credential name → touch policy. */
class FakeOath implements OathCredentialBroker {
  readonly onKey = new Map<string, { touch: boolean }>();
  available = true;
  provision = vi.fn(
    async (name: string, _label: string, options: { touch: boolean; replace: boolean }) => {
      if (this.onKey.has(name) && !options.replace) throw new Error("exists");
      this.onKey.set(name, { touch: options.touch });
    },
  );
  status = vi.fn((name: string): OathCredentialStatus =>
    this.available
      ? { state: this.onKey.has(name) ? "configured" : "missing" }
      : { state: "unavailable", detail: "no YubiKey with the OATH application is connected" },
  );
  remove = vi.fn((name: string) => {
    this.onKey.delete(name);
  });
}

function harness(options: { failUpsert?: boolean } = {}) {
  let revision = 0;
  let failNextUpsert = options.failUpsert ?? false;
  let config: AppConfig = {
    language: "en",
    oauth: { clientId: "client", tenant: "common" },
    roles: [{ id: "personal", name: "Personal", weeklyHours: 0, contexts: [], connectors: {} }],
  };
  const upsertConnector = vi.fn((role: string, kind: ConnectorKind, connector: ConnectorConfig) => {
    if (failNextUpsert) {
      failNextUpsert = false;
      throw new Error("disk full");
    }
    const target = config.roles.find((candidate) => candidate.id === role);
    if (!target) throw new Error("role missing");
    const list = [...(target.connectors[kind] ?? [])];
    const index = list.findIndex((candidate) => candidate.id === connector.id);
    const outcome = index === -1 ? ("created" as const) : ("updated" as const);
    if (index === -1) list.push(connector);
    else list[index] = connector;
    config = {
      ...config,
      roles: config.roles.map((candidate) =>
        candidate.id === role
          ? { ...candidate, connectors: { ...candidate.connectors, [kind]: list } }
          : candidate,
      ),
    };
    revision++;
    return outcome;
  });
  const manager = {
    get: () => config,
    get revision() {
      return revision;
    },
    get euleDirPath() {
      return "/tmp/eule-test";
    },
    upsertConnector,
    setGoogleOAuth: vi.fn((google) => {
      config = { ...config, google };
      revision++;
    }),
    upsertAutoAuth: vi.fn((account, patch) => {
      if (failNextUpsert) {
        failNextUpsert = false;
        throw new Error("disk full");
      }
      const previous = config.autoAuth?.find((entry) => entry.account === account);
      const merged = { ...previous, account, ...patch };
      if (patch.totpSecretRef) {
        delete merged.totpSecret;
        delete merged.totpYubikey;
      }
      if (patch.totpSecret) delete merged.totpSecretRef;
      if (patch.totpYubikey) {
        delete merged.totpSecret;
        delete merged.totpSecretRef;
      }
      for (const key of [
        "totpSecret",
        "totpSecretRef",
        "totpYubikey",
        "passwordSecretRef",
      ] as const)
        if (merged[key] === null) delete merged[key];
      config = { ...config, autoAuth: [merged] };
      revision++;
    }),
    removeAutoAuthCredential: vi.fn((account: string, kind: "totp" | "password") => {
      const previous = config.autoAuth?.find((entry) => entry.account === account);
      if (!previous) throw new Error("not configured");
      const next = { ...previous };
      if (kind === "totp") {
        delete next.totpSecret;
        delete next.totpSecretRef;
        delete next.totpYubikey;
      } else delete next.passwordSecretRef;
      config = {
        ...config,
        autoAuth:
          next.totpSecret || next.totpSecretRef || next.totpYubikey || next.passwordSecretRef
            ? [next]
            : undefined,
      };
      revision++;
    }),
  } as unknown as ConfigManager;
  const credentials = new FakeCredentials();
  const oath = new FakeOath();
  return {
    manager,
    credentials,
    oath,
    service: new ConfigurationControlService(manager, credentials, oath),
    getConfig: () => config,
    failNextUpsert: () => {
      failNextUpsert = true;
    },
    bumpRevision: () => {
      revision++;
    },
  };
}

describe("ConfigurationControlService", () => {
  it("captures required credentials and commits only their opaque reference", async () => {
    const context = harness();
    const result = await context.service.configureConnector({
      role: "personal",
      kind: "mail",
      type: "imap",
      account: "user@example.com",
      id: "icloud",
      host: "imap.example.com",
      smtpHost: "smtp.example.com",
    });
    expect(result).toMatchObject({ outcome: "created", credential: "captured" });
    const connector = context.getConfig().roles[0]?.connectors.mail?.[0];
    expect(connector?.credentialRef).toMatch(/^connector\/personal\/mail\/icloud\./);
    expect(connector?.password).toBeUndefined();
    expect(context.credentials.capture).toHaveBeenCalledTimes(1);
    expect(
      new ConfiguredCredentialResolver(context.manager, context.credentials).connector(connector!),
    ).toBe("secret");
  });

  it("stores the IMAP Sent mailbox options", async () => {
    const context = harness();
    await context.service.configureConnector({
      role: "personal",
      kind: "mail",
      type: "imap",
      account: "user@example.com",
      id: "icloud",
      host: "imap.example.com",
      smtpHost: "smtp.example.com",
      saveSentCopy: true,
      sentMailbox: "Sent Messages",
    });
    const connector = context.getConfig().roles[0]?.connectors.mail?.[0];
    expect(connector).toMatchObject({ saveSentCopy: true, sentMailbox: "Sent Messages" });
  });

  it("rejects invalid connector/domain combinations before prompting", async () => {
    const context = harness();
    await expect(
      context.service.configureConnector({
        role: "personal",
        kind: "calendar",
        type: "imap",
        account: "user@example.com",
        host: "imap.example.com",
        smtpHost: "smtp.example.com",
      }),
    ).rejects.toThrow(/does not support/);
    expect(context.credentials.capture).not.toHaveBeenCalled();
  });

  it("rejects missing fields and insecure URLs before prompting", async () => {
    const context = harness();
    await expect(
      context.service.configureConnector({
        role: "personal",
        kind: "calendar",
        type: "caldav",
        account: "user@example.com",
        url: "http://dav.example.com",
      }),
    ).rejects.toThrow(/must use https/);
    await expect(
      context.service.configureConnector({
        role: "personal",
        kind: "mail",
        type: "imap",
        account: "user@example.com",
      }),
    ).rejects.toThrow(/requires "host"/);
    expect(context.credentials.capture).not.toHaveBeenCalled();
  });

  it("rejects missing roles and cross-domain duplicate ids before prompting", async () => {
    const context = harness();
    await expect(
      context.service.configureConnector({
        role: "missing",
        kind: "mail",
        type: "imap",
        account: "user@example.com",
        host: "imap.example.com",
        smtpHost: "smtp.example.com",
      }),
    ).rejects.toThrow(/Role "missing" not found/);
    await context.service.configureConnector({
      role: "personal",
      kind: "mail",
      type: "m365",
      account: "user@example.com",
      id: "shared-id",
    });
    await expect(
      context.service.configureConnector({
        role: "personal",
        kind: "documents",
        type: "paperless",
        account: "paperless",
        id: "shared-id",
        url: "https://paperless.example.com",
      }),
    ).rejects.toThrow(/already exists/);
    expect(context.credentials.capture).not.toHaveBeenCalled();
  });

  it("compensates a newly captured credential when config commit fails", async () => {
    const context = harness({ failUpsert: true });
    await expect(
      context.service.configureConnector({
        role: "personal",
        kind: "documents",
        type: "paperless",
        account: "paperless",
        url: "https://paperless.example.com",
      }),
    ).rejects.toThrow(/disk full/);
    expect(context.credentials.removed).toEqual(context.credentials.captured);
  });

  it("rotates by committing a revisioned reference before deleting the old one", async () => {
    const context = harness();
    await context.service.configureConnector({
      role: "personal",
      kind: "mail",
      type: "imap",
      account: "user@example.com",
      id: "icloud",
      host: "imap.example.com",
      smtpHost: "smtp.example.com",
    });
    const oldReference = context.getConfig().roles[0]?.connectors.mail?.[0]?.credentialRef;
    await context.service.rotateConnectorCredential("personal", "mail", "icloud");
    const nextReference = context.getConfig().roles[0]?.connectors.mail?.[0]?.credentialRef;
    expect(nextReference).not.toBe(oldReference);
    expect(context.credentials.removed).toContain(oldReference);
  });

  it("keeps the active credential and removes the replacement when rotation fails", async () => {
    const context = harness();
    await context.service.configureConnector({
      role: "personal",
      kind: "mail",
      type: "imap",
      account: "user@example.com",
      id: "icloud",
      host: "imap.example.com",
      smtpHost: "smtp.example.com",
    });
    const oldReference = context.getConfig().roles[0]?.connectors.mail?.[0]?.credentialRef;
    context.failNextUpsert();
    await expect(
      context.service.rotateConnectorCredential("personal", "mail", "icloud"),
    ).rejects.toThrow(/disk full/);
    expect(context.getConfig().roles[0]?.connectors.mail?.[0]?.credentialRef).toBe(oldReference);
    expect(context.credentials.removed).not.toContain(oldReference);
    expect(context.credentials.removed.at(-1)).toBe(context.credentials.captured.at(-1));
  });

  it("rejects a stale post-prompt write and compensates its new credential", async () => {
    const context = harness();
    context.credentials.capture.mockImplementationOnce(async (reference: string) => {
      context.credentials.captured.push(reference);
      context.credentials.values.set(reference, "secret");
      context.bumpRevision();
    });
    await expect(
      context.service.configureConnector({
        role: "personal",
        kind: "documents",
        type: "paperless",
        account: "paperless",
        url: "https://paperless.example.com",
      }),
    ).rejects.toThrow(/changed while credentials were being entered/);
    expect(context.credentials.removed).toEqual(context.credentials.captured);
    expect(context.getConfig().roles[0]?.connectors.documents).toBeUndefined();
  });

  it("captures Google, TOTP, and M365 password secrets without resolving M365 values in Node", async () => {
    const context = harness();
    await context.service.configureGoogleOAuth("google-client");
    await context.service.configureTotp("User@Example.com");
    await context.service.configureM365Password("User@Example.com");
    expect(context.credentials.capture).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "TOTP seed for user@example.com",
      { format: "totp" },
    );
    expect(context.credentials.capture).toHaveBeenLastCalledWith(
      expect.stringMatching(/^oauth\/m365\/password\//),
      expect.stringContaining("store for automatic Eule webview sign-in"),
    );
    const statuses = context.service.credentialStatus();
    expect(statuses).toEqual([
      { scope: "google/oauth", state: "configured" },
      { scope: "totp/user@example.com", state: "configured" },
      { scope: "m365-password/user@example.com", state: "configured" },
    ]);
    expect(context.credentials.read).not.toHaveBeenCalled();
    const resolver = new ConfiguredCredentialResolver(context.manager, context.credentials);
    expect(resolver.googleOAuth()).toEqual({
      clientId: "google-client",
      clientSecret: "secret",
    });
    expect(resolver.m365AutoAuth("user@example.com")).toEqual({
      totpCredentialRef: expect.stringMatching(/^totp\//),
      passwordCredentialRef: expect.stringMatching(/^oauth\/m365\/password\//),
    });
    expect(context.credentials.read).toHaveBeenCalledTimes(1);
  });

  it("removes TOTP and password independently", async () => {
    const context = harness();
    await context.service.configureTotp("user@example.com");
    const totpReference = context.getConfig().autoAuth?.[0]?.totpSecretRef;
    await context.service.configureM365Password("user@example.com");
    const passwordReference = context.getConfig().autoAuth?.[0]?.passwordSecretRef;

    await context.service.removeTotp("user@example.com");
    expect(context.getConfig().autoAuth?.[0]?.passwordSecretRef).toBe(passwordReference);
    expect(context.credentials.removed).toContain(totpReference);
    expect(context.credentials.removed).not.toContain(passwordReference);

    await context.service.removeM365Password("user@example.com");
    expect(context.getConfig().autoAuth).toBeUndefined();
    expect(context.credentials.removed).toContain(passwordReference);
  });

  it("keeps the active M365 password binding when replacement commit fails", async () => {
    const context = harness();
    await context.service.configureM365Password("user@example.com");
    const activeReference = context.getConfig().autoAuth?.[0]?.passwordSecretRef;

    context.failNextUpsert();
    await expect(context.service.configureM365Password("user@example.com")).rejects.toThrow(
      /disk full/,
    );

    expect(context.getConfig().autoAuth?.[0]?.passwordSecretRef).toBe(activeReference);
    expect(context.credentials.removed).not.toContain(activeReference);
    expect(context.credentials.removed.at(-1)).toBe(context.credentials.captured.at(-1));
  });

  it("reports a required but unbound connector credential as missing", async () => {
    const context = harness();
    await context.service.configureConnector({
      role: "personal",
      kind: "mail",
      type: "imap",
      account: "user@example.com",
      host: "imap.example.com",
      smtpHost: "smtp.example.com",
    });
    const connector = context.getConfig().roles[0]?.connectors.mail?.[0];
    if (connector?.credentialRef) context.credentials.remove(connector.credentialRef);
    expect(context.service.credentialStatus()).toEqual([
      { scope: `personal/mail/${connector?.id ?? ""}`, state: "missing" },
    ]);
  });
});

describe("ConfigurationControlService TOTP on a YubiKey", () => {
  const account = "user@example.com";
  const credential = "eule:user@example.com";

  it("writes the seed under eule:<account> without touch and deletes the keychain seed it replaces", async () => {
    const context = harness();
    await context.service.configureTotp(account);
    const keychainReference = context.getConfig().autoAuth?.[0]?.totpSecretRef;

    await context.service.configureTotp("User@Example.com", { storage: "yubikey" });

    expect(context.oath.provision).toHaveBeenCalledWith(credential, `TOTP seed for ${account}`, {
      touch: false,
      replace: false,
    });
    expect(context.getConfig().autoAuth?.[0]).toEqual({
      account,
      totpYubikey: { credential, touch: false },
    });
    expect(context.credentials.removed).toContain(keychainReference);
  });

  it("takes touch from the request, else from the binding, and overwrites only its own credential", async () => {
    const context = harness();
    await context.service.configureTotp(account, { storage: "yubikey", touch: true });
    expect(context.oath.onKey.get(credential)).toEqual({ touch: true });

    await context.service.configureTotp(account, { storage: "yubikey" });
    expect(context.oath.provision).toHaveBeenLastCalledWith(credential, expect.any(String), {
      touch: true,
      replace: true,
    });
    expect(context.getConfig().autoAuth?.[0]?.totpYubikey).toEqual({ credential, touch: true });
  });

  it("refuses a missing key with the helper's reason and writes nothing", async () => {
    const context = harness();
    context.oath.available = false;
    await expect(context.service.configureTotp(account, { storage: "yubikey" })).rejects.toThrow(
      /YubiKey not usable: no YubiKey with the OATH application is connected/,
    );
    expect(context.oath.provision).not.toHaveBeenCalled();
    expect(context.getConfig().autoAuth).toBeUndefined();
  });

  it("leaves a credential of another name that is not bound to the account alone", async () => {
    const context = harness();
    const foreign = "Microsoft:user@example.com";
    context.oath.onKey.set(foreign, { touch: true });
    await expect(
      context.service.configureTotp(account, { storage: "yubikey", credential: foreign }),
    ).rejects.toThrow(/already holds a credential named "Microsoft:user@example.com"/);
    expect(context.oath.provision).not.toHaveBeenCalled();
    expect(context.oath.onKey.get(foreign)).toEqual({ touch: true });
  });

  it("treats eule:<account> as its own and overwrites it", async () => {
    const context = harness();
    context.oath.onKey.set(credential, { touch: true });
    await context.service.configureTotp(account, { storage: "yubikey" });
    expect(context.oath.provision).toHaveBeenCalledWith(credential, expect.any(String), {
      touch: false,
      replace: true,
    });
  });

  it("rejects a credential name the key cannot store before touching the key", async () => {
    const context = harness();
    const longAccount = `${"a".repeat(60)}@example.com`;
    await expect(
      context.service.configureTotp(longAccount, { storage: "yubikey" }),
    ).rejects.toThrow(/at most 64 bytes/);
    expect(context.oath.status).not.toHaveBeenCalled();
  });

  it("removes a freshly written credential when the binding cannot be saved", async () => {
    const context = harness();
    context.failNextUpsert();
    await expect(context.service.configureTotp(account, { storage: "yubikey" })).rejects.toThrow(
      /disk full/,
    );
    expect(context.oath.remove).toHaveBeenCalledWith(credential);
    expect(context.oath.onKey.has(credential)).toBe(false);
  });

  it("keeps the key's credential when the binding is removed or replaced by the keychain", async () => {
    const context = harness();
    await context.service.configureTotp(account, { storage: "yubikey" });
    await context.service.configureTotp(account);
    expect(context.getConfig().autoAuth?.[0]?.totpYubikey).toBeUndefined();
    expect(context.getConfig().autoAuth?.[0]?.totpSecretRef).toMatch(/^totp\//);

    await context.service.configureTotp(account, { storage: "yubikey" });
    await context.service.removeTotp(account);
    expect(context.getConfig().autoAuth).toBeUndefined();
    expect(context.oath.remove).not.toHaveBeenCalled();
    expect(context.oath.onKey.has(credential)).toBe(true);
  });

  it("reports the key's state and hands the login only the credential name", async () => {
    const context = harness();
    await context.service.configureTotp(account, { storage: "yubikey" });
    expect(context.service.credentialStatus()).toContainEqual({
      scope: `totp-yubikey/${account}`,
      state: "configured",
    });
    context.oath.available = false;
    expect(context.service.credentialStatus()).toContainEqual({
      scope: `totp-yubikey/${account}`,
      state: "unavailable",
    });
    const resolver = new ConfiguredCredentialResolver(context.manager, context.credentials);
    expect(resolver.m365AutoAuth(account)).toEqual({ totpYubikeyCredential: credential });
  });
});
