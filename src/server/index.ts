import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigManager } from "../config/index.js";
import { DatabaseManager, ContactManager } from "../db/index.js";
import {
  BookingService,
  ConfigService,
  ConfigurationControlService,
  CalendarService,
  ContactService,
  DocumentService,
  FileService,
  MailService,
  MessengerService,
  AttachmentService,
  AuthService,
  TaskService,
  UpdateService,
  updateNotice,
} from "../services/index.js";
import { registerAuthTools } from "../tools/auth-tools.js";
import { registerBookingTools } from "../tools/booking-tools.js";
import { registerConfigTools } from "../tools/config-tools.js";
import { registerConfigurationControlTools } from "../tools/configuration-control-tools.js";
import { registerCalendarTools } from "../tools/calendar-tools.js";
import { registerContactTools } from "../tools/contact-tools.js";
import { registerDocumentTools } from "../tools/document-tools.js";
import { registerFileTools } from "../tools/file-tools.js";
import { registerMailTools } from "../tools/mail-tools.js";
import { registerMessengerTools } from "../tools/messenger-tools.js";
import { registerTaskTools } from "../tools/task-tools.js";
import { registerUpdateTools } from "../tools/update-tools.js";
import { ConnectorRegistry } from "../connectors/index.js";
import { tokenRepository } from "../auth/token-repository.js";
import { M365Reauth } from "../auth/m365-reauth.js";
import { setLogOutput, logger } from "../utils/logger.js";
import { EULE_VERSION } from "../version.js";
import { nativeCredentialBroker } from "../helper/credential-store.js";
import { ConfiguredCredentialResolver } from "../helper/configured-credential-resolver.js";

setLogOutput("stderr");

const configManager = new ConfigManager();
const credentialResolver = new ConfiguredCredentialResolver(configManager, nativeCredentialBroker);
const authService = new AuthService(configManager, tokenRepository, credentialResolver);
// Accounts with `login: "safari"` get a dead sign-in renewed through Safari.
const reauth = new M365Reauth(configManager, (account) => authService.renewWithSafari(account));
const registry = new ConnectorRegistry(configManager, credentialResolver, reauth);
const configurationControl = new ConfigurationControlService(configManager, nativeCredentialBroker);

// Database initialized at startup, used by task/idea/note tools in Phase 2+.
export const dbManager = new DatabaseManager();

const server = new McpServer({
  name: "eule",
  version: EULE_VERSION,
});

// MCP Bundles cannot update themselves, so Eule points out newer releases.
const updateService = new UpdateService();
const updateChecksEnabled = configManager.get().updates?.check !== false;
registerAuthTools(server, authService, () =>
  updateChecksEnabled ? updateNotice(updateService.cached()) : undefined,
);
registerUpdateTools(server, updateService);

registerConfigTools(
  server,
  new ConfigService(configManager, (reference) => {
    nativeCredentialBroker.remove(reference);
  }),
);
registerConfigurationControlTools(server, configurationControl);

const mailService = new MailService(registry);
registerMailTools(server, mailService, new AttachmentService(mailService));

registerMessengerTools(server, new MessengerService(registry));

registerFileTools(server, new FileService(registry));

registerCalendarTools(server, new CalendarService(registry));

// --- Task tools ---
// Tasks live in the user's own system (Microsoft To Do, Apple Reminders,
// Nextcloud Tasks) rather than in a private store, so they route through the
// connector registry like every other domain.
registerTaskTools(server, new TaskService(registry));

const contactManager = new ContactManager(dbManager);
registerContactTools(server, new ContactService(registry, contactManager));
registerDocumentTools(server, new DocumentService(registry));
registerBookingTools(server, new BookingService(registry));

// --- Server startup ---

// A stray rejection or throw from a background task (token refresh, network
// I/O) must not silently kill the stdio server. Log to stderr (stdout is the
// MCP transport) and keep serving; only a truly unknown state exits.
process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err: unknown) => {
  logger.error("Uncaught exception:", err);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Advisory and rate-limited to once a day; failures stay silent.
  if (updateChecksEnabled) void updateService.status();
}

main().catch((error: unknown) => {
  logger.error("Eule MCP server failed to start:", error);
  process.exit(1);
});
