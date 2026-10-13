/**
 * Tells the user when a newer Eule release exists and fetches its extension
 * bundle on request.
 *
 * MCP Bundles have no update channel of their own: a locally installed
 * `.mcpb` changes only when the user installs a new one. Eule therefore
 * checks GitHub's latest release at most once a day and, when asked,
 * downloads the checksum-verified `eule-mcp.mcpb` to ~/Downloads. It never
 * rewrites its own installation directory, which the desktop app manages.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EULE_VERSION } from "../version.js";

const REPO = "metaneutrons/eule-mcp";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const BUNDLE_ASSET = "eule-mcp.mcpb";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseInfo {
  readonly version: string;
  readonly url: string;
  readonly bundleUrl?: string;
  readonly checksumUrl?: string;
}

export interface UpdateStatus {
  readonly current: string;
  readonly latest?: ReleaseInfo;
  readonly updateAvailable: boolean;
  readonly checkedAt?: string;
}

interface CacheFile {
  readonly checkedAt: string;
  readonly latest: ReleaseInfo;
}

export interface UpdateServiceOptions {
  readonly currentVersion?: string;
  readonly cachePath?: string;
  readonly downloadsDir?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Numeric `major.minor.patch`; a pre-release sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): { core: number[]; pre: boolean } => {
    const [core = "", pre] = version.replace(/^v/, "").split("-", 2);
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: !!pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class UpdateService {
  private readonly current: string;
  private readonly cachePath: string;
  private readonly downloadsDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private pending?: Promise<UpdateStatus>;

  constructor(options: UpdateServiceOptions = {}) {
    this.current = options.currentVersion ?? EULE_VERSION;
    this.cachePath = options.cachePath ?? join(homedir(), ".eule", "update-check.json");
    this.downloadsDir = options.downloadsDir ?? join(homedir(), "Downloads");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Status from the cache only; never touches the network. */
  cached(): UpdateStatus {
    const cache = this.readCache();
    return this.statusFrom(cache);
  }

  /**
   * Status, refreshed from GitHub when the cache is older than a day (or
   * `force`). Network errors fall back to the cached status.
   */
  async status(force = false): Promise<UpdateStatus> {
    const cache = this.readCache();
    const fresh = cache && this.now() - Date.parse(cache.checkedAt) < CHECK_INTERVAL_MS;
    if (fresh && !force) return this.statusFrom(cache);
    this.pending ??= this.refresh(cache).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /**
   * Download the latest release's bundle to ~/Downloads after verifying its
   * published SHA-256. Returns the file path.
   */
  async download(): Promise<{ path: string; version: string }> {
    const status = await this.status(true);
    const latest = status.latest;
    if (!latest) throw new Error("Could not determine the latest Eule release.");
    if (!latest.bundleUrl || !latest.checksumUrl)
      throw new Error(`Release v${latest.version} has no ${BUNDLE_ASSET} with checksum.`);

    const checksumText = (await this.fetchBuffer(latest.checksumUrl)).toString("utf8").trim();
    const expected = checksumText.split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected))
      throw new Error(`Malformed checksum for ${BUNDLE_ASSET}: ${checksumText}`);

    const path = join(this.downloadsDir, `eule-mcp-${latest.version}.mcpb`);
    if (existsSync(path) && sha256(readFileSync(path)) === expected)
      return { path, version: latest.version };

    const bundle = await this.fetchBuffer(latest.bundleUrl);
    if (sha256(bundle) !== expected)
      throw new Error(`Checksum mismatch for ${BUNDLE_ASSET} v${latest.version}; not saved.`);
    mkdirSync(this.downloadsDir, { recursive: true });
    writeFileSync(path, bundle);
    return { path, version: latest.version };
  }

  private async refresh(cache: CacheFile | undefined): Promise<UpdateStatus> {
    try {
      const response = await this.fetchImpl(LATEST_RELEASE_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `eule-mcp/${this.current}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const release = (await response.json()) as {
        tag_name?: string;
        html_url?: string;
        draft?: boolean;
        prerelease?: boolean;
        assets?: { name?: string; browser_download_url?: string }[];
      };
      if (!release.tag_name || release.draft || release.prerelease) return this.statusFrom(cache);
      const asset = (name: string): string | undefined =>
        release.assets?.find((entry) => entry.name === name)?.browser_download_url;
      const latest: ReleaseInfo = {
        version: release.tag_name.replace(/^v/, ""),
        url: release.html_url ?? `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
        bundleUrl: asset(BUNDLE_ASSET),
        checksumUrl: asset(`${BUNDLE_ASSET}.sha256`),
      };
      const next: CacheFile = { checkedAt: new Date(this.now()).toISOString(), latest };
      this.writeCache(next);
      return this.statusFrom(next);
    } catch {
      return this.statusFrom(cache);
    }
  }

  private statusFrom(cache: CacheFile | undefined): UpdateStatus {
    return {
      current: this.current,
      latest: cache?.latest,
      checkedAt: cache?.checkedAt,
      updateAvailable: !!cache && compareVersions(cache.latest.version, this.current) > 0,
    };
  }

  private readCache(): CacheFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as Partial<CacheFile>;
      if (typeof parsed.checkedAt !== "string" || typeof parsed.latest?.version !== "string")
        return undefined;
      return parsed as CacheFile;
    } catch {
      return undefined;
    }
  }

  private writeCache(cache: CacheFile): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true, mode: 0o700 });
      writeFileSync(this.cachePath, JSON.stringify(cache, null, 2));
    } catch {
      // The check is advisory; an unwritable cache only means checking again.
    }
  }

  private async fetchBuffer(url: string): Promise<Buffer> {
    const response = await this.fetchImpl(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`GET ${url} → HTTP ${String(response.status)}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

/** One-line notice for other tools, or undefined when Eule is current. */
export function updateNotice(status: UpdateStatus): string | undefined {
  if (!status.updateAvailable || !status.latest) return undefined;
  return `Update available: Eule ${status.latest.version} (installed ${status.current}). Use eule_update with action "download" to fetch the bundle. ${status.latest.url}`;
}
