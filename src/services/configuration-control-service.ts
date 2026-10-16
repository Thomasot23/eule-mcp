import {
  assertConnectorCapability,
  CONFIG_ID_PATTERN,
  CONNECTOR_CAPABILITIES,
  connectorCredentialRef,
  googleClientSecretRef,
  m365PasswordCredentialRef,
  parseConnectorConfig,
  totpCredentialRef,
  yubikeyCredentialName,
  yubikeyCredentialNameProblem,
} from "../config/index.js";
import type { ConfigManager } from "../config/index.js";
import {
  nativeOathBroker,
  type CredentialBroker,
  type CredentialState,
  type OathCredentialBroker,
} from "../helper/credential-store.js";
import type { ConnectorConfig, ConnectorKind } from "../types/index.js";
import { logger } from "../utils/logger.js";

export interface ConnectorConfigureInput {
  readonly role: string;
  readonly kind: ConnectorKind;
  readonly type: ConnectorConfig["type"];
  readonly account: string;
  readonly id?: string;
  readonly mailbox?: string;
  readonly host?: string;
  readonly port?: number;
  readonly smtpHost?: string;
  readonly smtpPort?: number;
  readonly saveSentCopy?: boolean;
  readonly sentMailbox?: string;
  readonly url?: string;
  readonly signalCliUrl?: string;
  readonly organization?: string;
  readonly access?: "admin" | "customer";
  readonly clientId?: string;
}

export interface TotpConfigureOptions {
  /** Where the seed lives: the OS credential store (default) or a YubiKey. */
  readonly storage?: "keychain" | "yubikey";
  /** YubiKey credential name; defaults to the bound one, else "eule:<account>". */
  readonly credential?: string;
  /** Require a touch for every YubiKey code; defaults to the bound value, else false. */
  readonly touch?: boolean;
}

export interface CredentialBindingStatus {
  readonly scope: string;
  readonly state: CredentialState | "legacy-inline";
}

/** Transactional configuration control plane. MCP passes metadata; helpers capture secrets. */
export class ConfigurationControlService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ConfigManager,
    private readonly credentials: CredentialBroker,
    private readonly oath: OathCredentialBroker = nativeOathBroker,
  ) {}

  async configureConnector(input: ConnectorConfigureInput): Promise<{
    outcome: "created" | "updated";
    credential: "captured" | "not-required";
    id: string;
  }> {
    const role = this.identity(input.role, "Role id");
    const account = input.account.trim();
    if (!account) throw new Error("Account is required");
    const id = this.identity(
      input.id ?? `${input.type}-${account.replace(/[^A-Za-z0-9]+/g, "-")}`,
      "Connector id",
    );
    return this.exclusive(`connector:${role}/${input.kind}/${id}`, () =>
      this.configureConnectorLocked({ ...input, role, account, id }),
    );
  }

  private async configureConnectorLocked(input: ConnectorConfigureInput & { id: string }): Promise<{
    outcome: "created" | "updated";
    credential: "captured" | "not-required";
    id: string;
  }> {
    const id = input.id;
    const role = this.config.get().roles.find((candidate) => candidate.id === input.role);
    if (!role) throw new Error(`Role "${input.role}" not found`);
    const duplicateKind = (
      Object.entries(role.connectors) as [ConnectorKind, readonly ConnectorConfig[]][]
    ).find(
      ([kind, connectors]) =>
        kind !== input.kind && connectors.some((connector) => connector.id === id),
    )?.[0];
    if (duplicateKind)
      throw new Error(
        `Connector id "${id}" already exists in role "${input.role}" domain "${duplicateKind}"`,
      );
    const existing = role.connectors[input.kind]?.find((candidate) => candidate.id === id);
    const revision = this.config.revision;
    const base = parseConnectorConfig({
      id,
      type: input.type,
      account: input.account,
      ...(input.mailbox ? { mailbox: input.mailbox } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.smtpHost ? { smtpHost: input.smtpHost } : {}),
      ...(input.smtpPort !== undefined ? { smtpPort: input.smtpPort } : {}),
      ...(input.saveSentCopy !== undefined ? { saveSentCopy: input.saveSentCopy } : {}),
      ...(input.sentMailbox ? { sentMailbox: input.sentMailbox } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.signalCliUrl ? { signalCliUrl: input.signalCliUrl } : {}),
      ...(input.organization ? { organization: input.organization } : {}),
      ...(input.access ? { access: input.access } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.type === "imap" ? { auth: "password" as const } : {}),
    });
    const capability = assertConnectorCapability(input.kind, base);
    const oldReference = existing?.credentialRef;
    let newReference: string | undefined;
    let connector = base;

    if (capability.credential !== "none") {
      newReference = connectorCredentialRef(input.role, input.kind, id);
      await this.credentials.capture(
        newReference,
        `${capability.credential === "token" ? "API token" : "Password"} for ${input.account} (${input.type})`,
      );
      connector = { ...base, credentialRef: newReference };
    }

    try {
      this.assertRevision(revision);
      const outcome = this.config.upsertConnector(input.role, input.kind, connector, revision);
      if (oldReference && oldReference !== newReference) this.tryRemove(oldReference);
      this.audit("connector.configured", {
        role: input.role,
        kind: input.kind,
        connectorId: id,
        connectorType: input.type,
        outcome,
      });
      return {
        outcome,
        credential: newReference ? "captured" : "not-required",
        id,
      };
    } catch (error) {
      if (newReference) this.tryRemove(newReference);
      throw error;
    }
  }

  async rotateConnectorCredential(role: string, kind: ConnectorKind, id: string): Promise<void> {
    const normalizedRole = this.identity(role, "Role id");
    const normalizedId = this.identity(id, "Connector id");
    return this.exclusive(`connector:${normalizedRole}/${kind}/${normalizedId}`, () =>
      this.rotateConnectorCredentialLocked(normalizedRole, kind, normalizedId),
    );
  }

  private async rotateConnectorCredentialLocked(
    role: string,
    kind: ConnectorKind,
    id: string,
  ): Promise<void> {
    const existing = this.findConnector(role, kind, id);
    if (!existing) throw new Error(`Connector "${role}/${kind}/${id}" not found`);
    const capability = assertConnectorCapability(kind, existing);
    if (capability.credential === "none")
      throw new Error(`Connector type "${existing.type}" does not use a stored credential`);
    const revision = this.config.revision;
    const nextReference = connectorCredentialRef(role, kind, id);
    await this.credentials.capture(
      nextReference,
      `New ${capability.credential === "token" ? "API token" : "password"} for ${existing.account} (${existing.type})`,
    );
    try {
      this.assertRevision(revision);
      this.config.upsertConnector(
        role,
        kind,
        {
          ...existing,
          password: undefined,
          token: undefined,
          credentialRef: nextReference,
        },
        revision,
      );
    } catch (error) {
      this.tryRemove(nextReference);
      throw error;
    }
    if (existing.credentialRef) this.tryRemove(existing.credentialRef);
    this.audit("credential.rotated", { role, kind, connectorId: id });
  }

  async configureGoogleOAuth(clientId: string): Promise<void> {
    return this.exclusive("google/oauth", () => this.configureGoogleOAuthLocked(clientId));
  }

  private async configureGoogleOAuthLocked(clientIdInput: string): Promise<void> {
    const clientId = clientIdInput.trim();
    if (!clientId) throw new Error("Google OAuth client id is required");
    const previous = this.config.get().google?.clientSecretRef;
    const revision = this.config.revision;
    const reference = googleClientSecretRef();
    await this.credentials.capture(reference, "Google OAuth client secret");
    try {
      this.assertRevision(revision);
      this.config.setGoogleOAuth({ clientId, clientSecretRef: reference }, revision);
    } catch (error) {
      this.tryRemove(reference);
      throw error;
    }
    if (previous) this.tryRemove(previous);
    this.audit("google_oauth.configured", { clientId });
  }

  async removeGoogleOAuth(): Promise<void> {
    return this.exclusive("google/oauth", () => {
      this.removeGoogleOAuthLocked();
    });
  }

  private removeGoogleOAuthLocked(): void {
    const reference = this.config.get().google?.clientSecretRef;
    if (!this.config.get().google) throw new Error("Google OAuth is not configured");
    this.config.setGoogleOAuth(undefined);
    if (reference) this.tryRemove(reference);
    this.audit("google_oauth.removed", {});
  }

  async configureTotp(accountInput: string, options: TotpConfigureOptions = {}): Promise<void> {
    const account = accountInput.trim().toLowerCase();
    if (!account) throw new Error("Account is required");
    return this.exclusive(`auto-auth:${account}`, () =>
      options.storage === "yubikey"
        ? this.configureTotpYubikeyLocked(account, options)
        : this.configureTotpLocked(account),
    );
  }

  /** Write the seed to a YubiKey and bind the account to that credential. A
   *  credential of the same name is only overwritten when this account is bound
   *  to it or it carries Eule's own name for the account ("eule:<account>");
   *  anything else of that name was put there by someone else. */
  private async configureTotpYubikeyLocked(
    account: string,
    options: TotpConfigureOptions,
  ): Promise<void> {
    const previous = this.config
      .get()
      .autoAuth?.find((entry) => entry.account.toLowerCase() === account);
    const revision = this.config.revision;
    const bound = previous?.totpYubikey;
    const credential = options.credential ?? bound?.credential ?? yubikeyCredentialName(account);
    const problem = yubikeyCredentialNameProblem(credential);
    if (problem)
      throw new Error(`YubiKey credential name ${problem}; choose another with "credential"`);
    const touch = options.touch ?? bound?.touch ?? false;
    const status = this.oath.status(credential);
    if (status.state === "unavailable")
      throw new Error(`YubiKey not usable: ${status.detail ?? "unknown reason"}`);
    const ours = bound?.credential === credential || credential === yubikeyCredentialName(account);
    if (status.state === "configured" && !ours)
      throw new Error(
        `The YubiKey already holds a credential named "${credential}"; choose another with "credential"`,
      );
    await this.oath.provision(credential, `TOTP seed for ${account}`, {
      touch,
      replace: status.state === "configured",
    });
    try {
      this.assertRevision(revision);
      this.config.upsertAutoAuth(account, { totpYubikey: { credential, touch } }, revision);
    } catch (error) {
      // Only a credential this call created is taken back; an overwritten one
      // cannot be restored.
      if (status.state === "missing") this.tryRemoveOath(credential);
      throw error;
    }
    // The seed now lives on the key only.
    if (previous?.totpSecretRef) this.tryRemove(previous.totpSecretRef);
    this.audit("totp.configured", { account, storage: "yubikey", touch });
  }

  private async configureTotpLocked(account: string): Promise<void> {
    const previous = this.config
      .get()
      .autoAuth?.find((entry) => entry.account.toLowerCase() === account);
    const revision = this.config.revision;
    const reference = totpCredentialRef(account);
    await this.credentials.capture(reference, `TOTP seed for ${account}`, { format: "totp" });
    try {
      this.assertRevision(revision);
      this.config.upsertAutoAuth(account, { totpSecret: null, totpSecretRef: reference }, revision);
    } catch (error) {
      this.tryRemove(reference);
      throw error;
    }
    if (previous?.totpSecretRef) this.tryRemove(previous.totpSecretRef);
    this.audit("totp.configured", { account });
  }

  async removeTotp(accountInput: string): Promise<void> {
    const account = accountInput.trim().toLowerCase();
    if (!account) throw new Error("Account is required");
    return this.exclusive(`auto-auth:${account}`, () => {
      this.removeTotpLocked(account);
    });
  }

  /** A YubiKey credential stays on the key: the binding alone does not show
   *  whether Eule wrote it or it was bound to an existing credential. */
  private removeTotpLocked(account: string): void {
    const reference = this.config
      .get()
      .autoAuth?.find((entry) => entry.account.toLowerCase() === account)?.totpSecretRef;
    this.config.removeAutoAuthCredential(account, "totp");
    if (reference) this.tryRemove(reference);
    this.audit("totp.removed", { account });
  }

  async configureM365Password(accountInput: string): Promise<void> {
    const account = accountInput.trim().toLowerCase();
    if (!account) throw new Error("Account is required");
    return this.exclusive(`auto-auth:${account}`, () => this.configureM365PasswordLocked(account));
  }

  private async configureM365PasswordLocked(account: string): Promise<void> {
    const previous = this.config
      .get()
      .autoAuth?.find((entry) => entry.account.toLowerCase() === account)?.passwordSecretRef;
    const revision = this.config.revision;
    const reference = m365PasswordCredentialRef(account);
    await this.credentials.capture(
      reference,
      `Microsoft 365 password for ${account} — store for automatic Eule webview sign-in`,
    );
    try {
      this.assertRevision(revision);
      this.config.upsertAutoAuth(account, { passwordSecretRef: reference }, revision);
    } catch (error) {
      this.tryRemove(reference);
      throw error;
    }
    if (previous) this.tryRemove(previous);
    this.audit("m365_password.configured", { account });
  }

  async removeM365Password(accountInput: string): Promise<void> {
    const account = accountInput.trim().toLowerCase();
    if (!account) throw new Error("Account is required");
    return this.exclusive(`auto-auth:${account}`, () => {
      const reference = this.config
        .get()
        .autoAuth?.find((entry) => entry.account.toLowerCase() === account)?.passwordSecretRef;
      this.config.removeAutoAuthCredential(account, "password");
      if (reference) this.tryRemove(reference);
      this.audit("m365_password.removed", { account });
    });
  }

  credentialStatus(): CredentialBindingStatus[] {
    const config = this.config.get();
    const bindings: { scope: string; reference?: string; legacy?: boolean; oath?: string }[] = [];
    for (const role of config.roles)
      for (const [kind, connectors] of Object.entries(role.connectors) as [
        ConnectorKind,
        readonly ConnectorConfig[],
      ][])
        for (const connector of connectors) {
          if (connector.credentialRef)
            bindings.push({
              scope: `${role.id}/${kind}/${connector.id}`,
              reference: connector.credentialRef,
            });
          else if (connector.password || connector.token)
            bindings.push({ scope: `${role.id}/${kind}/${connector.id}`, legacy: true });
          else if (CONNECTOR_CAPABILITIES[connector.type].credential !== "none")
            bindings.push({ scope: `${role.id}/${kind}/${connector.id}` });
        }
    if (config.google?.clientSecretRef)
      bindings.push({ scope: "google/oauth", reference: config.google.clientSecretRef });
    else if (config.google?.clientSecret) bindings.push({ scope: "google/oauth", legacy: true });
    for (const entry of config.autoAuth ?? []) {
      if (entry.totpSecretRef)
        bindings.push({ scope: `totp/${entry.account}`, reference: entry.totpSecretRef });
      else if (entry.totpSecret) bindings.push({ scope: `totp/${entry.account}`, legacy: true });
      else if (entry.totpYubikey)
        bindings.push({
          scope: `totp-yubikey/${entry.account}`,
          oath: entry.totpYubikey.credential,
        });
      if (entry.passwordSecretRef)
        bindings.push({
          scope: `m365-password/${entry.account}`,
          reference: entry.passwordSecretRef,
        });
    }
    return bindings.map((binding) => ({
      scope: binding.scope,
      state: binding.legacy
        ? "legacy-inline"
        : binding.reference
          ? this.credentials.status(binding.reference)
          : binding.oath
            ? this.oath.status(binding.oath).state
            : "missing",
    }));
  }

  private findConnector(
    role: string,
    kind: ConnectorKind,
    id: string,
  ): ConnectorConfig | undefined {
    return this.config
      .get()
      .roles.find((candidate) => candidate.id === role)
      ?.connectors[kind]?.find((candidate) => candidate.id === id);
  }

  private identity(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.length > 128 || !CONFIG_ID_PATTERN.test(normalized))
      throw new Error(
        `${label} must start with an alphanumeric character and contain only letters, digits, '.', '_' or '-'`,
      );
    return normalized;
  }

  private assertRevision(expected: string): void {
    if (this.config.revision !== expected)
      throw new Error(
        "Configuration changed while credentials were being entered; retry the request",
      );
  }

  private async exclusive<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private tryRemoveOath(name: string): void {
    try {
      this.oath.remove(name);
    } catch (error) {
      logger.warn(
        `YubiKey cleanup failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private tryRemove(reference: string): void {
    try {
      this.credentials.remove(reference);
    } catch (error) {
      logger.warn(
        `Credential cleanup failed for ${reference}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private audit(event: string, metadata: Record<string, unknown>): void {
    logger.info(JSON.stringify({ event: `config.${event}`, ...metadata }));
  }
}
