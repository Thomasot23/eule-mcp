import { z } from "zod";
import type { AppConfig, ConnectorConfig } from "../types/index.js";
import {
  CONNECTOR_CREDENTIAL_REF_PATTERN,
  GOOGLE_CREDENTIAL_REF_PATTERN,
  M365_PASSWORD_CREDENTIAL_REF_PATTERN,
  TOTP_CREDENTIAL_REF_PATTERN,
  yubikeyCredentialNameProblem,
} from "./credential-references.js";
import { assertConnectorCapability } from "./connector-capabilities.js";

export const CONNECTOR_KINDS = [
  "mail",
  "calendar",
  "contacts",
  "messenger",
  "files",
  "documents",
  "tasks",
  "wiki",
] as const;

export const CONNECTOR_TYPES = [
  "m365",
  "imap",
  "caldav",
  "carddav",
  "ical",
  "signal",
  "google",
  "paperless",
  "mediawiki",
] as const;

export const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const id = z.string().trim().min(1).max(128).regex(CONFIG_ID_PATTERN);
const account = z.string().trim().min(1).max(320);

const yubikeyTotp = z
  .object({
    credential: z.string().superRefine((name, ctx) => {
      const problem = yubikeyCredentialNameProblem(name);
      if (problem) ctx.addIssue({ code: "custom", message: `YubiKey credential name ${problem}` });
    }),
    touch: z.boolean().optional(),
  })
  .strict();

export const connectorSchema = z
  .object({
    id,
    type: z.enum(CONNECTOR_TYPES).default("m365"),
    account,
    mailbox: account.optional(),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    smtpHost: z.string().trim().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    saveSentCopy: z.boolean().optional(),
    sentMailbox: z.string().trim().min(1).optional(),
    auth: z.enum(["oauth", "password"]).optional(),
    password: z.string().optional(),
    credentialRef: z.string().regex(CONNECTOR_CREDENTIAL_REF_PATTERN).optional(),
    url: z.url().optional(),
    token: z.string().optional(),
    signalCliUrl: z.url().optional(),
  })
  .strict()
  .superRefine((connector, ctx) => {
    if (connector.credentialRef && (connector.password || connector.token))
      ctx.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "credentialRef cannot be combined with inline password or token",
      });
  });

const connectorGroups = z.object(
  Object.fromEntries(
    CONNECTOR_KINDS.map((kind) => [kind, z.array(connectorSchema).optional()]),
  ) as Record<(typeof CONNECTOR_KINDS)[number], z.ZodOptional<z.ZodArray<typeof connectorSchema>>>,
);

const roleSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(200),
    weeklyHours: z.number().min(0).max(168),
    contexts: z.array(z.string().trim().min(1).max(128)).default([]),
    connectors: connectorGroups.default({}),
    signature: z.string().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    policy: z
      .object({
        enabled: z.boolean().optional(),
        readOnly: z.boolean().optional(),
        allowedConnectorKinds: z.array(z.enum(CONNECTOR_KINDS)).min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const appConfigSchema = z
  .object({
    language: z.enum(["de", "en"]).default("de"),
    oauth: z
      .object({
        clientId: z.string().trim().min(1),
        tenant: z.string().trim().min(1),
        apiVersion: z.enum(["v1", "v2"]).optional(),
        redirectUri: z.url().optional(),
        extraScopes: z.array(z.string().trim().min(1)).optional(),
      })
      .strict()
      .default({
        clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
        tenant: "common",
      }),
    google: z
      .object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1).optional(),
        clientSecretRef: z.string().regex(GOOGLE_CREDENTIAL_REF_PATTERN).optional(),
      })
      .strict()
      .superRefine((google, ctx) => {
        if (Boolean(google.clientSecret) === Boolean(google.clientSecretRef))
          ctx.addIssue({
            code: "custom",
            path: ["clientSecretRef"],
            message: "configure exactly one of clientSecret or clientSecretRef",
          });
      })
      .optional(),
    autoAuth: z
      .array(
        z
          .object({
            account,
            totpSecret: z.string().min(1).optional(),
            totpSecretRef: z.string().regex(TOTP_CREDENTIAL_REF_PATTERN).optional(),
            totpYubikey: yubikeyTotp.optional(),
            passwordSecretRef: z.string().regex(M365_PASSWORD_CREDENTIAL_REF_PATTERN).optional(),
            login: z.enum(["safari"]).optional(),
          })
          .strict()
          .superRefine((entry, ctx) => {
            if (entry.totpSecret && entry.totpSecretRef)
              ctx.addIssue({
                code: "custom",
                path: ["totpSecretRef"],
                message: "totpSecret and totpSecretRef cannot be combined",
              });
            if (entry.totpYubikey && (entry.totpSecret || entry.totpSecretRef))
              ctx.addIssue({
                code: "custom",
                path: ["totpYubikey"],
                message: "totpYubikey cannot be combined with totpSecret or totpSecretRef",
              });
            if (
              !entry.totpSecret &&
              !entry.totpSecretRef &&
              !entry.totpYubikey &&
              !entry.passwordSecretRef &&
              !entry.login
            )
              ctx.addIssue({
                code: "custom",
                path: ["passwordSecretRef"],
                message: "configure at least one auto-auth credential reference",
              });
          }),
      )
      .optional(),
    updates: z
      .object({
        /** Check GitHub for a newer release at most once a day (default true). */
        check: z.boolean().default(true),
      })
      .strict()
      .optional(),
    roles: z.array(roleSchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const autoAuthAccounts = new Set<string>();
    for (const [entryIndex, entry] of (config.autoAuth ?? []).entries()) {
      const normalized = entry.account.toLowerCase();
      if (autoAuthAccounts.has(normalized))
        ctx.addIssue({
          code: "custom",
          path: ["autoAuth", entryIndex, "account"],
          message: "duplicate auto-auth account",
        });
      autoAuthAccounts.add(normalized);
    }
    const roleIds = new Set<string>();
    for (const [roleIndex, role] of config.roles.entries()) {
      if (roleIds.has(role.id))
        ctx.addIssue({
          code: "custom",
          path: ["roles", roleIndex, "id"],
          message: "duplicate role id",
        });
      roleIds.add(role.id);
      const connectorIds = new Set<string>();
      for (const kind of CONNECTOR_KINDS) {
        for (const [connectorIndex, connector] of (role.connectors[kind] ?? []).entries()) {
          if (connectorIds.has(connector.id))
            ctx.addIssue({
              code: "custom",
              path: ["roles", roleIndex, "connectors", kind, connectorIndex, "id"],
              message: "connector id must be unique within a role",
            });
          connectorIds.add(connector.id);
          try {
            assertConnectorCapability(kind, connector);
          } catch (error) {
            ctx.addIssue({
              code: "custom",
              path: ["roles", roleIndex, "connectors", kind, connectorIndex],
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  });

export function parseAppConfig(raw: unknown): AppConfig {
  const result = appConfigSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function parseConnectorConfig(raw: unknown): ConnectorConfig {
  const result = connectorSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid connector:\n${z.prettifyError(result.error)}`);
  return result.data;
}
