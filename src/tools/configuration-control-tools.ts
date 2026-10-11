import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONNECTOR_CAPABILITIES, CONNECTOR_KINDS, CONNECTOR_TYPES } from "../config/index.js";
import type {
  ConfigurationControlService,
  ConnectorConfigureInput,
} from "../services/configuration-control-service.js";
import { executeTool, textResult } from "./tool-runtime.js";

const INTERACTIVE_TIMEOUT_MS = 5 * 60 * 1000;
const connectorInputSchema = {
  role: z.string().trim().min(1),
  kind: z.enum(CONNECTOR_KINDS),
  type: z.enum(CONNECTOR_TYPES),
  account: z.string().trim().min(1),
  id: z.string().trim().min(1).optional(),
  mailbox: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  smtpHost: z.string().trim().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  saveSentCopy: z
    .boolean()
    .optional()
    .describe("IMAP: file sent mail in the Sent folder (default true; off for Gmail/Microsoft)"),
  url: z.url().optional(),
  signalCliUrl: z.url().optional(),
} as const;

export function registerConfigurationControlTools(
  server: McpServer,
  control: ConfigurationControlService,
): void {
  const configure = (toolName: string, input: ConnectorConfigureInput, signal?: AbortSignal) =>
    executeTool(
      toolName,
      async () => {
        const result = await control.configureConnector(input);
        return textResult(
          `✅ ${result.outcome === "created" ? "Created" : "Updated"} connector "${result.id}". Credential: ${result.credential}.`,
        );
      },
      { timeoutMs: INTERACTIVE_TIMEOUT_MS, signal },
    );

  server.registerTool(
    "connector_capabilities",
    {
      description:
        "Discover supported connector types, valid domains, required/optional fields, credential mode, and authentication next steps",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, extra) =>
      executeTool(
        "connector_capabilities",
        () =>
          textResult(
            Object.entries(CONNECTOR_CAPABILITIES)
              .map(
                ([type, capability]) =>
                  `${type}: domains=${capability.kinds.join(",")} required=${capability.requiredFields.join(",") || "none"} optional=${
                    [
                      ...capability.optionalFields,
                      ...Object.entries(capability.optionalFieldsByKind ?? {}).map(
                        ([kind, fields]) => `${kind}:${fields.join("+")}`,
                      ),
                    ].join(",") || "none"
                  } localCredential=${capability.credential} next=${capability.nextStep ?? "ready"}`,
              )
              .join("\n"),
          ),
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "connector_configure",
    {
      description:
        "Create or update a connector. If a secret is required, opens a branded local Eule window; the secret never enters MCP or model context. [WRITES config/keychain]",
      inputSchema: connectorInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => configure("connector_configure", input, extra.signal),
  );

  server.registerTool(
    "account_add",
    {
      description:
        "Deprecated alias for connector_configure. Creates or updates a connector and captures any required secret in the branded local Eule window. [WRITES config/keychain]",
      inputSchema: connectorInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => configure("account_add", input, extra.signal),
  );

  server.registerTool(
    "credential_rotate",
    {
      description:
        "Rotate a connector password/token through a branded local Eule window. The old credential remains active until configuration commits. [WRITES config/keychain]",
      inputSchema: {
        role: z.string(),
        kind: z.enum(CONNECTOR_KINDS),
        id: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ role, kind, id }, extra) =>
      executeTool(
        "credential_rotate",
        async () => {
          await control.rotateConnectorCredential(role, kind, id);
          return textResult(`✅ Rotated credential for "${role}/${kind}/${id}".`);
        },
        { timeoutMs: INTERACTIVE_TIMEOUT_MS, signal: extra.signal },
      ),
  );

  server.registerTool(
    "credential_status",
    {
      description:
        "Report credential presence for connectors, Google OAuth, TOTP, and opt-in M365 password autofill without exposing secret values",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, extra) =>
      executeTool(
        "credential_status",
        () => {
          const statuses = control.credentialStatus();
          return textResult(
            statuses.map((entry) => `${entry.scope}: ${entry.state}`).join("\n") ||
              "No stored credential bindings configured.",
          );
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "google_oauth_configure",
    {
      description:
        "Configure a Google OAuth client and capture its client secret in a branded local Eule window. [WRITES config/keychain]",
      inputSchema: { clientId: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ clientId }, extra) =>
      executeTool(
        "google_oauth_configure",
        async () => {
          await control.configureGoogleOAuth(clientId);
          return textResult("✅ Configured Google OAuth client and stored its secret locally.");
        },
        { timeoutMs: INTERACTIVE_TIMEOUT_MS, signal: extra.signal },
      ),
  );

  server.registerTool(
    "google_oauth_remove",
    {
      description:
        "Remove Google OAuth client configuration and its local credential. [DESTRUCTIVE]",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (_input, extra) =>
      executeTool(
        "google_oauth_remove",
        async () => {
          await control.removeGoogleOAuth();
          return textResult("✅ Removed Google OAuth configuration and credential.");
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "totp_configure",
    {
      description:
        "Capture or rotate an account TOTP seed in a branded local Eule window. With storage=yubikey the seed is written to a connected YubiKey instead of the OS credential store, optionally requiring a touch per code. [WRITES config/keychain/YubiKey]",
      inputSchema: {
        account: z.email(),
        storage: z
          .enum(["keychain", "yubikey"])
          .optional()
          .describe("Where the seed lives; default keychain"),
        credential: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("YubiKey credential name; default eule:<account>"),
        touch: z
          .boolean()
          .optional()
          .describe("YubiKey only: require a touch for every code; default false"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ account, storage, credential, touch }, extra) =>
      executeTool(
        "totp_configure",
        async () => {
          await control.configureTotp(account, {
            ...(storage ? { storage } : {}),
            ...(credential ? { credential } : {}),
            ...(touch !== undefined ? { touch } : {}),
          });
          return textResult(
            storage === "yubikey"
              ? `✅ Wrote the TOTP seed for ${account.toLowerCase()} to the YubiKey.`
              : `✅ Stored TOTP seed for ${account.toLowerCase()} in the OS credential store.`,
          );
        },
        { timeoutMs: INTERACTIVE_TIMEOUT_MS, signal: extra.signal },
      ),
  );

  server.registerTool(
    "totp_remove",
    {
      description: "Remove an account TOTP seed configuration and local credential. [DESTRUCTIVE]",
      inputSchema: { account: z.email() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ account }, extra) =>
      executeTool(
        "totp_remove",
        async () => {
          await control.removeTotp(account);
          return textResult(`✅ Removed TOTP configuration for ${account.toLowerCase()}.`);
        },
        { signal: extra.signal },
      ),
  );

  server.registerTool(
    "m365_password_configure",
    {
      description:
        "Opt in to Microsoft 365 password autofill. Opens a branded local Eule window and stores the password in the OS credential store; the secret never enters MCP, model context, Node, argv, environment variables, or a temporary file. Autofill is restricted to https://login.microsoftonline.com. [WRITES config/keychain]",
      inputSchema: { account: z.email() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ account }, extra) =>
      executeTool(
        "m365_password_configure",
        async () => {
          await control.configureM365Password(account);
          return textResult(
            `✅ Stored the opt-in Microsoft 365 password for ${account.toLowerCase()} in the OS credential store.`,
          );
        },
        { timeoutMs: INTERACTIVE_TIMEOUT_MS, signal: extra.signal },
      ),
  );

  server.registerTool(
    "m365_password_remove",
    {
      description:
        "Remove an account's Microsoft 365 password-autofill binding and local credential. [DESTRUCTIVE]",
      inputSchema: { account: z.email() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ account }, extra) =>
      executeTool(
        "m365_password_remove",
        async () => {
          await control.removeM365Password(account);
          return textResult(
            `✅ Removed Microsoft 365 password autofill for ${account.toLowerCase()}.`,
          );
        },
        { signal: extra.signal },
      ),
  );
}
