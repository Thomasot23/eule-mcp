import { createHash, randomUUID } from "node:crypto";
import type { ConnectorKind } from "../types/index.js";

const segment = (value: string): string => {
  const normalized = value.trim().replace(/[^A-Za-z0-9@+._-]+/g, "-");
  if (!normalized) throw new Error("Credential reference segment cannot be empty");
  return normalized;
};

const revision = (): string => randomUUID().replaceAll("-", "");

export function connectorCredentialRef(
  role: string,
  kind: ConnectorKind,
  connectorId: string,
): string {
  return `connector/${segment(role)}/${kind}/${segment(connectorId)}.${revision()}`;
}

export function googleClientSecretRef(): string {
  return `oauth/google/client-secret.${revision()}`;
}

export function totpCredentialRef(account: string): string {
  const accountHash = createHash("sha256").update(account.trim().toLowerCase()).digest("hex");
  return `totp/${accountHash}.${revision()}`;
}

/** Default name of the OATH credential Eule writes to a YubiKey for an account. */
export function yubikeyCredentialName(account: string): string {
  return `eule:${account.trim().toLowerCase()}`;
}

/** The YKOATH applet stores names of at most 64 bytes. */
export const YUBIKEY_CREDENTIAL_NAME_MAX_BYTES = 64;

/** Problem with a YubiKey OATH credential name, or undefined when it is usable. */
export function yubikeyCredentialNameProblem(name: string): string | undefined {
  if (name.length === 0) return "must not be empty";
  if (Buffer.byteLength(name, "utf8") > YUBIKEY_CREDENTIAL_NAME_MAX_BYTES)
    return `must be at most ${String(YUBIKEY_CREDENTIAL_NAME_MAX_BYTES)} bytes`;
  for (const char of name)
    if (char < " " || char === "\u007f") return "must not contain control characters";
  return undefined;
}

export function m365PasswordCredentialRef(account: string): string {
  const accountHash = createHash("sha256").update(account.trim().toLowerCase()).digest("hex");
  return `oauth/m365/password/${accountHash}.${revision()}`;
}

export const CONNECTOR_CREDENTIAL_REF_PATTERN =
  /^connector\/[A-Za-z0-9@+][A-Za-z0-9@+._-]*\/(?:mail|calendar|contacts|messenger|files|documents|booking)\/[A-Za-z0-9@+][A-Za-z0-9@+._-]*$/;
export const GOOGLE_CREDENTIAL_REF_PATTERN = /^oauth\/google\/client-secret(?:\.[A-Za-z0-9]+)?$/;
export const TOTP_CREDENTIAL_REF_PATTERN = /^totp\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const M365_PASSWORD_CREDENTIAL_REF_PATTERN =
  /^oauth\/m365\/password\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
