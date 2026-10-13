import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, UpdateService, updateNotice } from "../src/services/update-service.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "eule-update-"));
  temporaryDirectories.push(directory);
  return directory;
}

const BUNDLE = Buffer.from("bundle-bytes");
const BUNDLE_SHA = createHash("sha256").update(BUNDLE).digest("hex");

function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    html_url: `https://github.com/metaneutrons/eule-mcp/releases/tag/${tag}`,
    assets: [
      { name: "eule-mcp.mcpb", browser_download_url: "https://example.test/eule-mcp.mcpb" },
      {
        name: "eule-mcp.mcpb.sha256",
        browser_download_url: "https://example.test/eule-mcp.mcpb.sha256",
      },
    ],
    ...extra,
  };
}

function fakeFetch(body: Record<string, unknown>, bundle = BUNDLE, checksum = BUNDLE_SHA) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify(body));
    if (url.endsWith(".sha256")) return new Response(`${checksum}  eule-mcp.mcpb\n`);
    if (url.endsWith(".mcpb")) return new Response(bundle);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function service(fetchImpl: typeof fetch, now = () => Date.parse("2026-10-13T08:00:00Z")) {
  const directory = tempDir();
  return {
    directory,
    updates: new UpdateService({
      currentVersion: "0.9.1",
      cachePath: join(directory, "update-check.json"),
      downloadsDir: join(directory, "Downloads"),
      fetch: fetchImpl,
      now,
    }),
  };
}

describe("compareVersions", () => {
  it("orders by numeric major, minor and patch", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBe(1);
    expect(compareVersions("v0.9.1", "0.9.1")).toBe(0);
    expect(compareVersions("0.9.0", "0.9.1")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });
});

describe("UpdateService", () => {
  it("reports a newer release and points to the download action", async () => {
    const { updates } = service(fakeFetch(release("v0.9.2")));
    const status = await updates.status();
    expect(status.updateAvailable).toBe(true);
    expect(status.latest?.version).toBe("0.9.2");
    expect(updateNotice(status)).toContain("Eule 0.9.2 (installed 0.9.1)");
  });

  it("stays quiet when the installed version is current", async () => {
    const { updates } = service(fakeFetch(release("v0.9.1")));
    const status = await updates.status();
    expect(status.updateAvailable).toBe(false);
    expect(updateNotice(status)).toBeUndefined();
  });

  it("asks GitHub at most once a day", async () => {
    const fetchImpl = fakeFetch(release("v0.9.2"));
    let now = Date.parse("2026-10-13T08:00:00Z");
    const { updates } = service(fetchImpl, () => now);
    await updates.status();
    now += 60 * 60 * 1000;
    await updates.status();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 24 * 60 * 60 * 1000;
    await updates.status();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached status when GitHub is unreachable", async () => {
    const { updates, directory } = service(
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    writeFileSync(
      join(directory, "update-check.json"),
      JSON.stringify({
        checkedAt: "2026-10-10T08:00:00Z",
        latest: { version: "0.9.2", url: "https://example.test" },
      }),
    );
    const status = await updates.status();
    expect(status.updateAvailable).toBe(true);
    expect(updates.cached().latest?.version).toBe("0.9.2");
  });

  it("ignores drafts and pre-releases", async () => {
    const { updates } = service(fakeFetch(release("v1.0.0-rc.1", { prerelease: true })));
    const status = await updates.status();
    expect(status.latest).toBeUndefined();
    expect(status.updateAvailable).toBe(false);
  });

  it("downloads the verified bundle to the downloads folder", async () => {
    const { updates, directory } = service(fakeFetch(release("v0.9.2")));
    const result = await updates.download();
    expect(result).toEqual({
      path: join(directory, "Downloads", "eule-mcp-0.9.2.mcpb"),
      version: "0.9.2",
    });
    expect(readFileSync(result.path)).toEqual(BUNDLE);
  });

  it("refuses a bundle whose checksum does not match", async () => {
    const { updates, directory } = service(fakeFetch(release("v0.9.2"), Buffer.from("tampered")));
    await expect(updates.download()).rejects.toThrow(/Checksum mismatch/);
    expect(existsSync(join(directory, "Downloads", "eule-mcp-0.9.2.mcpb"))).toBe(false);
  });

  it("explains a release without a bundle", async () => {
    const { updates } = service(fakeFetch(release("v0.9.2", { assets: [] })));
    await expect(updates.download()).rejects.toThrow(/has no eule-mcp.mcpb/);
  });
});
