/**
 * The user's real download folder. macOS always uses ~/Downloads, but Linux
 * names it per locale through XDG user dirs (often ~/Herunterladen) and
 * Windows lets the user move it (another drive, OneDrive). Every lookup
 * failure falls back to ~/Downloads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** FOLDERID_Downloads; Windows stores the folder under this GUID. */
const WINDOWS_DOWNLOADS_ID = "{374DE290-123F-4565-9164-39C4925E467B}";
const WINDOWS_SHELL_FOLDERS =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

export interface DownloadsDirOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly readFile?: (path: string) => string | undefined;
  readonly exists?: (path: string) => boolean;
  /** Output of `reg query` for the Downloads value, or undefined on failure. */
  readonly queryRegistry?: () => string | undefined;
}

function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function queryWindowsRegistry(): string | undefined {
  try {
    return execFileSync("reg", ["query", WINDOWS_SHELL_FOLDERS, "/v", WINDOWS_DOWNLOADS_ID], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** `XDG_DOWNLOAD_DIR` from the environment or the user-dirs.dirs file. */
export function xdgDownloadDir(
  env: NodeJS.ProcessEnv,
  home: string,
  readFile: (path: string) => string | undefined,
): string | undefined {
  let value = env.XDG_DOWNLOAD_DIR;
  if (!value) {
    // The spec ignores an empty or relative XDG_CONFIG_HOME.
    const configured = env.XDG_CONFIG_HOME;
    const configHome = configured && isAbsolute(configured) ? configured : join(home, ".config");
    const file = readFile(join(configHome, "user-dirs.dirs"));
    const line = file
      ?.split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => !entry.startsWith("#") && /^XDG_DOWNLOAD_DIR\s*=/.test(entry));
    value = line
      ?.replace(/^XDG_DOWNLOAD_DIR\s*=\s*/, "")
      .replace(/^"(.*)"$/, "$1")
      .trim();
  }
  if (!value) return undefined;
  const expanded = value.replace(/^\$(?:\{HOME\}|HOME)(?=\/|$)/, home);
  if (!isAbsolute(expanded)) return undefined;
  // The spec disables a user dir by pointing it at $HOME itself.
  if (resolve(expanded) === resolve(home)) return undefined;
  return expanded;
}

/** The Downloads known folder from `reg query` output, %VARS% expanded. */
export function windowsDownloadDir(
  output: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const line = output
    ?.split(/\r?\n/)
    .find((entry) => entry.includes(WINDOWS_DOWNLOADS_ID) && /REG_(EXPAND_)?SZ/.test(entry));
  const raw = line?.split(/REG_(?:EXPAND_)?SZ/)[1]?.trim();
  if (!raw) return undefined;
  const lookup = (name: string): string | undefined => {
    const key = Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return key ? env[key] : undefined;
  };
  const names = [...raw.matchAll(/%([^%]+)%/g)].map((match) => match[1] ?? "");
  if (names.some((name) => lookup(name) === undefined)) return undefined;
  const expanded = raw.replace(/%([^%]+)%/g, (_match, name: string) => lookup(name) ?? "");
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(expanded) ? expanded : undefined;
}

export function downloadsDirectory(options: DownloadsDirOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  const fallback = join(home, "Downloads");

  let candidate: string | undefined;
  if (platform === "win32")
    candidate = windowsDownloadDir((options.queryRegistry ?? queryWindowsRegistry)(), env);
  else if (platform !== "darwin")
    candidate = xdgDownloadDir(env, home, options.readFile ?? readFileOrUndefined);

  return candidate && exists(candidate) ? candidate : fallback;
}
