import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  assetName,
  bundledHelperDir,
  ensureHelper,
  localHelperPath,
} from "../src/helper/download.js";

const temporaryDirectories: string[] = [];
const originalOverride = process.env.EULE_HELPER_PATH;

afterEach(() => {
  if (originalOverride === undefined) delete process.env.EULE_HELPER_PATH;
  else process.env.EULE_HELPER_PATH = originalOverride;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "helper");
  chmodSync(path, 0o700);
  return realpathSync(path);
}

describe("assetName", () => {
  it("maps every supported platform/arch to its release asset", () => {
    expect(assetName("darwin", "arm64")).toBe("eule-helper-darwin-universal");
    expect(assetName("darwin", "x64")).toBe("eule-helper-darwin-universal");
    expect(assetName("linux", "x64")).toBe("eule-helper-linux-x64");
    expect(assetName("linux", "arm64")).toBe("eule-helper-linux-arm64");
    expect(assetName("win32", "x64")).toBe("eule-helper-win32-x64.exe");
    expect(assetName("win32", "arm64")).toBe("eule-helper-win32-arm64.exe");
  });

  it("names the bundle directory after the release asset", () => {
    expect(bundledHelperDir("darwin", "arm64")).toBe("darwin-universal");
    expect(bundledHelperDir("linux", "arm64")).toBe("linux-arm64");
    expect(bundledHelperDir("win32", "x64")).toBe("win32-x64");
  });

  it("throws for an unsupported platform/arch", () => {
    expect(() => assetName("linux", "ia32")).toThrow();
    expect(() => assetName("aix", "ppc64")).toThrow();
  });
});

describe("local helper resolution", () => {
  it("prefers an explicit trusted helper without accessing GitHub", async () => {
    const root = mkdtempSync(join(tmpdir(), "eule-helper-"));
    temporaryDirectories.push(root);
    const helper = executable(join(root, "custom-helper"));
    process.env.EULE_HELPER_PATH = helper;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(ensureHelper("0.0.0-unpublished")).resolves.toBe(helper);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discovers release builds in a source checkout before debug builds", () => {
    const root = mkdtempSync(join(tmpdir(), "eule-source-"));
    temporaryDirectories.push(root);
    executable(join(root, "helper", "target", "debug", "eule-helper"));
    const release = executable(join(root, "helper", "target", "release", "eule-helper"));

    expect(localHelperPath({ packageRoot: root, override: null, platform: "linux" })).toBe(release);
  });

  it("picks this platform's helper from a Claude Desktop extension", () => {
    const root = mkdtempSync(join(tmpdir(), "eule-bundle-"));
    temporaryDirectories.push(root);
    executable(join(root, "bin", "linux-x64", "eule-helper"));
    const arm = executable(join(root, "bin", "linux-arm64", "eule-helper"));
    const win = executable(join(root, "bin", "win32-x64", "eule-helper.exe"));

    expect(
      localHelperPath({ packageRoot: root, override: null, platform: "linux", arch: "arm64" }),
    ).toBe(arm);
    expect(
      localHelperPath({ packageRoot: root, override: null, platform: "win32", arch: "x64" }),
    ).toBe(win);
    expect(
      localHelperPath({ packageRoot: root, override: null, platform: "linux", arch: "ia32" }),
    ).toBeUndefined();
  });

  it("restores a bundled helper's executable bit lost while unpacking", () => {
    const root = mkdtempSync(join(tmpdir(), "eule-bundle-"));
    temporaryDirectories.push(root);
    const bundled = executable(join(root, "bin", "linux-x64", "eule-helper"));
    chmodSync(bundled, 0o644);

    expect(
      localHelperPath({ packageRoot: root, override: null, platform: "linux", arch: "x64" }),
    ).toBe(bundled);
  });

  it("prefers a source-checkout build over a bundled helper", () => {
    const root = mkdtempSync(join(tmpdir(), "eule-bundle-"));
    temporaryDirectories.push(root);
    executable(join(root, "bin", "linux-x64", "eule-helper"));
    const release = executable(join(root, "helper", "target", "release", "eule-helper"));

    expect(localHelperPath({ packageRoot: root, override: null, platform: "linux" })).toBe(release);
  });

  it("rejects relative override paths instead of executing an ambiguous binary", () => {
    expect(() => localHelperPath({ override: "./eule-helper", platform: "linux" })).toThrow(
      /absolute path/,
    );
  });
});
