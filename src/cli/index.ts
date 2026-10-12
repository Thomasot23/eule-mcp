import { ConfigManager } from "../config/index.js";
import {
  authenticateAccount,
  authenticateAccountDeviceCode,
  tierAuthParam,
  loadTokens,
  REDIRECT_URI,
} from "../providers/m365/index.js";
import { oauthCapture, oauthSafari } from "../helper/run.js";
import { cachedHelperPath, localHelperPath } from "../helper/download.js";
import { createInterface } from "node:readline/promises";
import { nativeCredentialBroker } from "../helper/credential-store.js";
import { ConfiguredCredentialResolver } from "../helper/configured-credential-resolver.js";
import { ConfigurationControlService } from "../services/index.js";
import type { ApiTier, ConnectorConfig, ConnectorKind, OAuthConfig } from "../types/index.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

/** Minimal --flag / --flag value parser for the flags after the command word. */
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * Whether a native login window can plausibly be shown. A remote shell has no
 * usable window server even on macOS/Windows, so SSH sessions are treated as
 * headless and get the device-code flow instead.
 */
function hasDesktopSession(): boolean {
  if (process.env.SSH_CONNECTION ?? process.env.SSH_TTY) return false;
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
}

async function configure(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("configure requires an interactive local terminal");
  const io = createInterface({ input: process.stdin, output: process.stdout });
  const config = new ConfigManager();
  const control = new ConfigurationControlService(config, nativeCredentialBroker);
  try {
    console.log("\nEule configuration wizard — secrets stay in your OS credential store\n");
    const roleId = (await io.question("Role id [personal]: ")).trim() || "personal";
    const existing = config.get().roles.find((role) => role.id === roleId);
    if (!existing) {
      const name = (await io.question("Role name [Personal]: ")).trim() || "Personal";
      let weeklyHours: number | undefined;
      do {
        const hoursText = (await io.question("Weekly hours [0]: ")).trim();
        const candidate = hoursText ? Number(hoursText) : 0;
        if (Number.isFinite(candidate) && candidate >= 0 && candidate <= 168) {
          weeklyHours = candidate;
        } else {
          console.log("Enter a number from 0 to 168.");
        }
      } while (weeklyHours === undefined);
      config.addRole({
        id: roleId,
        name,
        weeklyHours,
        contexts: [],
        connectors: {},
      });
    }

    console.log("1) Microsoft 365  2) IMAP/SMTP  3) CalDAV  4) CardDAV  5) Paperless");
    const choice = (await io.question("Connector type: ")).trim();
    const definitions: Record<string, { type: ConnectorConfig["type"]; kind: ConnectorKind }> = {
      "1": { type: "m365", kind: "mail" },
      "2": { type: "imap", kind: "mail" },
      "3": { type: "caldav", kind: "calendar" },
      "4": { type: "carddav", kind: "contacts" },
      "5": { type: "paperless", kind: "documents" },
    };
    const definition = definitions[choice];
    if (!definition) throw new Error("Unsupported connector selection");
    const account = (await io.question("Account / username: ")).trim();
    if (!account) throw new Error("Account is required");
    const id = (await io.question(`Connector id [${definition.type}]: `)).trim() || definition.type;
    let host: string | undefined;
    let smtpHost: string | undefined;
    let url: string | undefined;
    if (definition.type === "imap") {
      host = (await io.question("IMAP host: ")).trim();
      smtpHost = (await io.question("SMTP host: ")).trim();
    } else if (["caldav", "carddav", "paperless"].includes(definition.type)) {
      url = (await io.question("Service URL (https://): ")).trim();
    }
    const result = await control.configureConnector({
      role: roleId,
      kind: definition.kind,
      type: definition.type,
      account,
      id,
      ...(host ? { host } : {}),
      ...(smtpHost ? { smtpHost } : {}),
      ...(url ? { url } : {}),
    });
    console.log(`\n✅ Configured ${definition.type} connector ${roleId}/${definition.kind}/${id}.`);
    console.log(`Credential: ${result.credential}.`);
    if (definition.type === "m365") console.log("Next: run eule-mcp login --account " + account);
  } finally {
    io.close();
  }
}

/** Deprecated — kept as a thin alias so existing docs/muscle-memory still work.
 *  `login` is the real entry (native window, device code, or legacy browser). */
async function setup(): Promise<void> {
  const tokens = loadTokens();
  console.log("Note: `setup` is deprecated — use `login`. Delegating…\n");
  if (Object.keys(tokens.accounts).length > 0) {
    console.log("Authenticated accounts:");
    for (const [account, token] of Object.entries(tokens.accounts)) {
      const expired = token.expiresAt < Date.now() ? " (expired, will refresh)" : "";
      console.log(`  ${account}: tier ${token.tier}${expired}`);
    }
    console.log(
      "\nTip: eule-mcp login --tier ews   (add --device over SSH, --capture for broker clients)\n",
    );
  }
  // Any flags after `setup` are honoured by login() (it parses args.slice(1)).
  await login();
}

async function login(): Promise<void> {
  const flags = parseFlags(args.slice(1));
  const configManager = new ConfigManager();
  const config = configManager.get();
  const secrets = new ConfiguredCredentialResolver(configManager, nativeCredentialBroker);

  const tier: ApiTier = (
    ["graph", "ews", "imap"].includes(String(flags.tier)) ? String(flags.tier) : "ews"
  ) as ApiTier;
  const account = typeof flags.account === "string" ? flags.account : undefined;

  // Overlay CLI flags on the configured oauth defaults. --client-id lets you
  // pick the app the tenant actually consents (e.g. Apple Internet Accounts for
  // EWS); --api-version v1 is required for legacy public clients.
  const apiVersion =
    flags["api-version"] === "v1" || flags["api-version"] === "v2"
      ? flags["api-version"]
      : config.oauth.apiVersion;
  const oauth: OAuthConfig = {
    clientId: typeof flags["client-id"] === "string" ? flags["client-id"] : config.oauth.clientId,
    tenant: typeof flags.tenant === "string" ? flags.tenant : config.oauth.tenant,
    apiVersion,
    redirectUri:
      typeof flags["redirect-uri"] === "string" ? flags["redirect-uri"] : config.oauth.redirectUri,
  };

  // Flow selection. An explicit flag always wins. Otherwise pick what this
  // machine can actually run: the native window on a desktop session, device
  // code when headless or over SSH. The browser paste-the-redirect flow is the
  // worst of the three for the user and is now only used when named directly.
  const explicit = flags.safari
    ? "safari"
    : flags.capture
      ? "capture"
      : flags.device
        ? "device"
        : flags.browser
          ? "browser"
          : undefined;
  const mode = explicit ?? (hasDesktopSession() ? "capture" : "device");

  /** Native webview login. Returns the helper's exit code. */
  const captureLogin = async (): Promise<number> => {
    // The helper writes tokens.json itself; the code never returns through this
    // process. Required for clients whose only redirect URIs are broker-bound
    // (e.g. Apple Internet Accounts EWS), and the nicer path everywhere else.
    const param = tierAuthParam(oauth, tier);
    // Only opaque references cross this boundary. The native helper resolves
    // TOTP/password directly from the OS store and may be disabled per login.
    const autoAuth = account ? secrets.m365AutoAuth(account) : {};
    const totpCredentialRef = flags["no-totp"] ? undefined : autoAuth.totpCredentialRef;
    const totpYubikeyCredential = flags["no-totp"] ? undefined : autoAuth.totpYubikeyCredential;
    const passwordCredentialRef = flags["no-password"] ? undefined : autoAuth.passwordCredentialRef;
    console.log(
      `\nNative login window, tier ${tier}, client ${oauth.clientId}` +
        (passwordCredentialRef ? " (auto-password)" : "") +
        (totpCredentialRef ? " (auto-TOTP)" : "") +
        (totpYubikeyCredential ? " (auto-TOTP from YubiKey)" : "") +
        "\n",
    );
    return oauthCapture({
      clientId: oauth.clientId,
      tier,
      apiVersion: oauth.apiVersion === "v1" ? "v1" : "v2",
      resource: "resource" in param ? param.resource : undefined,
      scope: "scope" in param ? param.scope : undefined,
      tenant: oauth.tenant,
      loginHint: account,
      // A configured/flagged redirect always wins. Otherwise an explicit
      // --capture keeps the helper's broker default (oob) so existing
      // broker-bound setups behave exactly as before, while the automatic path
      // targets the ordinary navigable redirect the default client registers.
      redirectUri: oauth.redirectUri ?? (explicit ? undefined : REDIRECT_URI),
      totpCredentialRef,
      totpYubikeyCredential,
      passwordCredentialRef,
    });
  };

  /** Sign-in in the user's Safari: security keys, and Safari's own Microsoft session. */
  const safariLogin = async (): Promise<void> => {
    if (!account) throw new Error("--account <email> is required for --safari");
    if (process.platform !== "darwin")
      throw new Error("The Safari sign-in is only available on macOS");
    const param = tierAuthParam(oauth, tier);
    console.log(`\nSafari sign-in, tier ${tier}, client ${oauth.clientId}`);
    console.log(
      "   Safari opens in the background. If its Microsoft session is not enough, it comes\n" +
        "   forward so you can finish, e.g. with your security key.\n",
    );
    const code = await oauthSafari({
      clientId: oauth.clientId,
      tier,
      apiVersion: oauth.apiVersion === "v1" ? "v1" : "v2",
      resource: "resource" in param ? param.resource : undefined,
      scope: "scope" in param ? param.scope : undefined,
      tenant: oauth.tenant,
      loginHint: account,
    });
    if (code !== 0) process.exit(code);
    configManager.upsertAutoAuth(account, { login: "safari" });
    console.log(`\n✅ Signed in through Safari: ${account}`);
    console.log("   When this sign-in expires, Eule renews it through Safari on its own.");
  };

  const deviceLogin = async (): Promise<void> => {
    console.log(`\nDevice-code login, tier ${tier}, client ${oauth.clientId}\n`);
    const token = await authenticateAccountDeviceCode(tier, oauth, (p) => {
      console.log("==================================================");
      console.log(`  Open:  ${p.verificationUrl}`);
      console.log(`  Code:  ${p.userCode}`);
      console.log("==================================================");
      console.log("  Waiting for you to complete sign-in…\n");
    });
    console.log(`\n✅ Success! ${token.account} (tier ${token.tier})`);
    console.log(`   Expires: ${new Date(token.expiresAt).toLocaleString()}`);
  };

  try {
    if (mode === "capture") {
      let code: number;
      try {
        code = await captureLogin();
      } catch (err) {
        // The helper could not be obtained at all (no release for this platform,
        // download blocked, no local build). That is a machine-capability
        // problem rather than a failed sign-in, so the automatic path degrades
        // to device code. An explicit --capture still surfaces the error.
        if (explicit) throw err;
        console.log(
          `Native login window unavailable (${err instanceof Error ? err.message : String(err)}).`,
        );
        console.log("Falling back to the device-code flow.");
        await deviceLogin();
        return;
      }
      // A non-zero exit means the sign-in itself failed or was cancelled. Do not
      // silently start a second flow behind the user's back.
      if (code !== 0) process.exit(code);
      console.log("\n✅ Token written to ~/.eule/tokens.json");
      return;
    }
    if (mode === "device") {
      await deviceLogin();
      return;
    }
    if (mode === "safari") {
      await safariLogin();
      return;
    }
    // Legacy browser authorization-code flow: sign in, then paste the redirect
    // URL back by hand. Kept only for environments where no helper binary may
    // run and the tenant also blocks device code.
    const token = await authenticateAccount(tier, account, oauth);
    console.log(`\n✅ Success! ${token.account} (tier ${token.tier})`);
    console.log(`   Expires: ${new Date(token.expiresAt).toLocaleString()}`);
  } catch (err) {
    console.error("\n❌ Login failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function secretCmd(): Promise<void> {
  const sub = args[1];
  const flags = parseFlags(args.slice(2));
  if (sub !== "totp" && sub !== "password") {
    console.log("Usage: eule-mcp secret <totp|password> --account <email> [--remove]");
    console.log(
      "       eule-mcp secret totp --account <email> --yubikey [--credential <name>] [--touch|--no-touch]",
    );
    process.exit(1);
  }
  const account = typeof flags.account === "string" ? flags.account : undefined;
  if (!account) {
    console.error("--account <email> is required");
    process.exit(1);
  }

  // The helper validates and stores the value directly in the OS credential
  // store. Node receives only success/failure; the secret never crosses argv,
  // stdout, config.yaml, or model context.
  const cfgMgr = new ConfigManager();
  const control = new ConfigurationControlService(cfgMgr, nativeCredentialBroker);
  try {
    if (flags.remove) {
      if (sub === "totp") await control.removeTotp(account);
      else await control.removeM365Password(account);
      console.log(
        `\n✅ ${sub === "totp" ? "TOTP secret" : "M365 password"} removed for ${account}.`,
      );
    } else if (sub === "totp" && flags.yubikey) {
      // The seed goes from the helper's window straight to the key. Touch comes
      // from --touch/--no-touch, else the configured value, else off.
      await control.configureTotp(account, {
        storage: "yubikey",
        ...(typeof flags.credential === "string" ? { credential: flags.credential } : {}),
        ...(flags.touch ? { touch: true } : flags["no-touch"] ? { touch: false } : {}),
      });
      console.log(`\n✅ TOTP seed written to the YubiKey for ${account}.`);
      console.log(`   Use it:  eule-mcp login --account ${account} …`);
    } else {
      if (sub === "totp") await control.configureTotp(account);
      else await control.configureM365Password(account);
      console.log(
        `\n✅ ${sub === "totp" ? "TOTP secret" : "M365 password"} stored for ${account} in the OS credential store.`,
      );
      console.log(`   Use it:  eule-mcp login --capture --account ${account} …`);
    }
  } catch (err) {
    console.error("\n❌ Failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "login":
      await login();
      break;
    case "configure":
      await configure();
      break;
    case "secret":
      await secretCmd();
      break;
    case "serve":
      await import("../server/index.js");
      break;
    case "helper-path": {
      const local = localHelperPath();
      if (local) {
        console.log(local);
      } else {
        console.error(
          `No local eule-helper; it is downloaded on first use to ${cachedHelperPath()}`,
        );
        process.exitCode = 1;
      }
      break;
    }
    default:
      console.log("Eule MCP — Kiro Office Agent 🦉\n");
      console.log("Usage:");
      console.log("  eule-mcp configure                    Local role/account setup wizard");
      console.log("  eule-mcp setup                        Interactive account setup");
      console.log("  eule-mcp login [--tier ews]           Native window, device code if headless");
      console.log("       [--account <email>] [--client-id <id>] [--api-version v1|v2]");
      console.log(
        "  eule-mcp login --capture [--tier ews] Force the native window (broker clients)",
      );
      console.log("  eule-mcp login --device [--tier ews]  Force device code (works over SSH)");
      console.log("  eule-mcp login --browser [--tier ews] Legacy browser paste-the-redirect");
      console.log(
        "  eule-mcp login --safari --account <email> Sign in through Safari (security keys, macOS)",
      );
      console.log(
        "  eule-mcp secret totp --account <email> Store a TOTP secret via a local window",
      );
      console.log(
        "       add --yubikey [--credential <name>] [--touch] to keep it on a YubiKey instead",
      );
      console.log(
        "  eule-mcp secret password --account <email> Opt in to local M365 password autofill",
      );
      console.log("       add --remove to delete either stored auto-auth credential");
      console.log("  eule-mcp serve                        Start MCP server (stdio)");
      console.log("  eule-mcp helper-path                  Print the local eule-helper in use");
      console.log("  eule-mcp help                         Show this help");
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error);
  process.exit(1);
});
