/**
 * Locate (and, on first use, download) the platform-native `eule-helper` binary.
 *
 * The helper is a small Rust GUI tool (webview OAuth capture + secret prompt).
 * Source checkouts and explicitly configured development builds are preferred;
 * installed packages lazily fetch the matching, checksum-verified release asset.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EULE_VERSION } from "../version.js";

const REPO = "metaneutrons/eule-mcp";

function findPackageRoot(start: string): string | undefined {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// Works both from src/helper/download.ts and from tsup's dist/chunk-*.js output.
const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/** GitHub release asset name for the current platform + architecture. */
export function assetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "darwin") return "eule-helper-darwin-universal";
  if (platform === "linux") {
    if (arch === "x64") return "eule-helper-linux-x64";
    if (arch === "arm64") return "eule-helper-linux-arm64";
  }
  if (platform === "win32") {
    if (arch === "x64") return "eule-helper-win32-x64.exe";
    if (arch === "arm64") return "eule-helper-win32-arm64.exe";
  }
  throw new Error(`No eule-helper build for ${platform}/${arch}.`);
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "eule-helper.exe" : "eule-helper";
}

function assertRunnable(path: string, platform: NodeJS.Platform, source: string): string {
  if (!isAbsolute(path)) throw new Error(`${source} must be an absolute path: ${path}`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`${source} is not a file: ${canonical}`);
  accessSync(canonical, platform === "win32" ? constants.F_OK : constants.X_OK);
  return canonical;
}

export interface LocalHelperOptions {
  /** `null` disables the environment override, which is useful for deterministic tests. */
  readonly override?: string | null;
  readonly packageRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/**
 * Directory of this platform's helper inside a Claude Desktop extension bundle,
 * named after its release asset: `bin/darwin-universal/`, `bin/linux-x64/`, …
 */
export function bundledHelperDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return assetName(platform, arch)
    .replace(/^eule-helper-/, "")
    .replace(/\.exe$/, "");
}

/**
 * Resolve an explicitly trusted helper, a Cargo build from this source checkout,
 * or the helper shipped for this platform inside a Claude Desktop extension.
 */
export function localHelperPath(options: LocalHelperOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const override =
    options.override === undefined ? process.env.EULE_HELPER_PATH : (options.override ?? undefined);
  if (override) return assertRunnable(override, platform, "EULE_HELPER_PATH");

  const root = options.packageRoot ?? PACKAGE_ROOT;
  if (!root) return undefined;
  const name = binaryName(platform);
  for (const profile of ["release", "debug"] as const) {
    const candidate = join(root, "helper", "target", profile, name);
    if (existsSync(candidate))
      return assertRunnable(candidate, platform, `Local ${profile} helper`);
  }

  let bundleDir: string;
  try {
    bundleDir = bundledHelperDir(platform, options.arch ?? process.arch);
  } catch {
    return undefined;
  }
  const bundled = join(root, "bin", bundleDir, name);
  if (existsSync(bundled)) {
    // An extension installer may drop the executable bit when unpacking.
    if (platform !== "win32" && (statSync(bundled).mode & 0o111) === 0) chmodSync(bundled, 0o755);
    return assertRunnable(bundled, platform, "Bundled helper");
  }
  return undefined;
}

/** Cached release-binary location (~/.eule/bin/eule-helper[.exe]). */
export function cachedHelperPath(): string {
  const name = binaryName(process.platform);
  return join(homedir(), ".eule", "bin", name);
}

/** Best currently available helper path for synchronous credential-store operations. */
export function helperPath(): string {
  return localHelperPath() ?? cachedHelperPath();
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${String(res.status)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Ensure the helper binary is present and checksum-valid, downloading it if
 * needed. Returns its absolute path. `version` defaults to this package's
 * version (→ tag `v<version>`), overridable for tests.
 */
export async function ensureHelper(version = EULE_VERSION): Promise<string> {
  const local = localHelperPath();
  if (local) return local;

  const dest = cachedHelperPath();
  const asset = assetName();
  const base = `https://github.com/${REPO}/releases/download/v${version}/${asset}`;

  // Fetch the expected checksum first (small); if the cached binary already
  // matches it, skip the (large) binary download entirely.
  let shaText: string;
  try {
    shaText = (await fetchBuffer(`${base}.sha256`)).toString("utf-8").trim();
  } catch (error) {
    throw new Error(
      `No verified eule-helper is available for v${version}. Build it locally with "cargo build --release --manifest-path helper/Cargo.toml", set EULE_HELPER_PATH to an absolute trusted binary, or publish the matching GitHub release.`,
      { cause: error },
    );
  }
  const expected = shaText.split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`Malformed checksum for ${asset}: ${shaText}`);
  }

  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) return dest;

  const bin = await fetchBuffer(base);
  if (sha256(bin) !== expected) {
    throw new Error(`Checksum mismatch for ${asset} — refusing to install.`);
  }
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  writeFileSync(dest, bin, { mode: 0o700 });
  chmodSync(dest, 0o700); // mode is honored only on create; enforce on overwrite
  return dest;
}
