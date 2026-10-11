import type { ConnectorConfig, ConnectorKind } from "../types/index.js";
import { assertSecureUrl } from "../utils/security.js";

const CONFIGURABLE_FIELDS = [
  "mailbox",
  "host",
  "port",
  "smtpHost",
  "smtpPort",
  "saveSentCopy",
  "url",
  "signalCliUrl",
] as const satisfies readonly (keyof ConnectorConfig)[];

export interface ConnectorCapability {
  readonly kinds: readonly ConnectorKind[];
  readonly credential: "none" | "password" | "token";
  readonly requiredFields: readonly (keyof ConnectorConfig)[];
  readonly optionalFields: readonly (keyof ConnectorConfig)[];
  readonly optionalFieldsByKind?: Partial<
    Record<ConnectorKind, readonly (keyof ConnectorConfig)[]>
  >;
  readonly nextStep?: "auth_login_m365" | "google_oauth_then_auth_login";
}

/** SSOT for valid connector/domain combinations and required local configuration. */
export const CONNECTOR_CAPABILITIES: Readonly<
  Record<ConnectorConfig["type"], ConnectorCapability>
> = {
  m365: {
    // "tasks" is Microsoft To Do via Graph; it needs the Tasks.ReadWrite scope,
    // which is opt-in through oauth.extraScopes.
    kinds: ["mail", "calendar", "contacts", "messenger", "files", "tasks"],
    credential: "none",
    requiredFields: [],
    optionalFields: [],
    optionalFieldsByKind: { mail: ["mailbox"], calendar: ["mailbox"] },
    nextStep: "auth_login_m365",
  },
  google: {
    kinds: ["mail", "calendar", "contacts", "files"],
    credential: "none",
    requiredFields: [],
    optionalFields: [],
    nextStep: "google_oauth_then_auth_login",
  },
  imap: {
    kinds: ["mail"],
    credential: "password",
    requiredFields: ["host", "smtpHost"],
    optionalFields: ["port", "smtpPort", "saveSentCopy"],
  },
  caldav: {
    // "tasks" is VTODO over the same collection set (Apple Reminders,
    // Nextcloud Tasks), so it reuses the CalDAV credentials unchanged.
    kinds: ["calendar", "tasks"],
    credential: "password",
    requiredFields: ["url"],
    optionalFields: [],
  },
  carddav: {
    kinds: ["contacts"],
    credential: "password",
    requiredFields: ["url"],
    optionalFields: [],
  },
  ical: {
    kinds: ["calendar"],
    credential: "none",
    requiredFields: ["url"],
    optionalFields: [],
  },
  signal: {
    kinds: ["messenger"],
    credential: "none",
    requiredFields: ["signalCliUrl"],
    optionalFields: [],
  },
  paperless: {
    kinds: ["documents"],
    credential: "token",
    requiredFields: ["url"],
    optionalFields: [],
  },
};

export function assertConnectorCapability(
  kind: ConnectorKind,
  connector: ConnectorConfig,
): ConnectorCapability {
  const capability = CONNECTOR_CAPABILITIES[connector.type];
  if (!capability.kinds.includes(kind))
    throw new Error(`Connector type "${connector.type}" does not support domain "${kind}"`);
  for (const field of capability.requiredFields)
    if (connector[field] === undefined || connector[field] === "")
      throw new Error(`Connector type "${connector.type}" requires "${field}"`);
  const supportedFields = new Set([
    ...capability.requiredFields,
    ...capability.optionalFields,
    ...(capability.optionalFieldsByKind?.[kind] ?? []),
  ]);
  for (const field of CONFIGURABLE_FIELDS)
    if (connector[field] !== undefined && !supportedFields.has(field))
      throw new Error(`Connector type "${connector.type}" does not support "${field}"`);
  if (
    capability.credential === "none" &&
    (connector.password || connector.token || connector.credentialRef)
  )
    throw new Error(`Connector type "${connector.type}" does not use a local credential`);
  if (capability.credential === "password" && connector.token)
    throw new Error(`Connector type "${connector.type}" requires a password, not a token`);
  if (capability.credential === "token" && connector.password)
    throw new Error(`Connector type "${connector.type}" requires a token, not a password`);
  if (connector.type === "imap" && connector.auth && connector.auth !== "password")
    throw new Error('Generic IMAP connectors support only auth="password"');
  if (connector.type !== "imap" && connector.auth)
    throw new Error(`Connector type "${connector.type}" does not support "auth"`);
  if (connector.url) assertSecureUrl(connector.url, `${connector.type} URL`);
  if (connector.signalCliUrl) assertSecureUrl(connector.signalCliUrl, "Signal CLI URL");
  return capability;
}
