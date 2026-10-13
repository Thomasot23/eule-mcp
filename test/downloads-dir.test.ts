import { describe, expect, it } from "vitest";
import {
  downloadsDirectory,
  windowsDownloadDir,
  xdgDownloadDir,
} from "../src/utils/downloads-dir.js";

const HOME = "/home/fabian";
const USER_DIRS = [
  "# This file is written by xdg-user-dirs-update",
  'XDG_DESKTOP_DIR="$HOME/Schreibtisch"',
  'XDG_DOWNLOAD_DIR="$HOME/Herunterladen"',
  "",
].join("\n");

const REG_OUTPUT = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
  "    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Downloads",
  "",
].join("\r\n");

describe("xdgDownloadDir", () => {
  const files = (map: Record<string, string>) => (path: string) => map[path];

  it("reads the localized folder from user-dirs.dirs and expands $HOME", () => {
    const read = files({ [`${HOME}/.config/user-dirs.dirs`]: USER_DIRS });
    expect(xdgDownloadDir({}, HOME, read)).toBe(`${HOME}/Herunterladen`);
  });

  it("prefers the environment variable and honours XDG_CONFIG_HOME", () => {
    expect(xdgDownloadDir({ XDG_DOWNLOAD_DIR: "/data/dl" }, HOME, () => undefined)).toBe(
      "/data/dl",
    );
    const read = files({ "/cfg/user-dirs.dirs": 'XDG_DOWNLOAD_DIR="${HOME}/Dl"' });
    expect(xdgDownloadDir({ XDG_CONFIG_HOME: "/cfg" }, HOME, read)).toBe(`${HOME}/Dl`);
  });

  it("treats a folder pointing at $HOME as disabled", () => {
    const read = files({ [`${HOME}/.config/user-dirs.dirs`]: 'XDG_DOWNLOAD_DIR="$HOME/"' });
    expect(xdgDownloadDir({}, HOME, read)).toBeUndefined();
  });

  it("ignores relative values and missing files", () => {
    expect(xdgDownloadDir({ XDG_DOWNLOAD_DIR: "Downloads" }, HOME, () => undefined)).toBe(
      undefined,
    );
    expect(xdgDownloadDir({}, HOME, () => undefined)).toBeUndefined();
  });
});

describe("windowsDownloadDir", () => {
  it("expands environment variables case-insensitively", () => {
    expect(windowsDownloadDir(REG_OUTPUT, { UserProfile: "C:\\Users\\fabian" })).toBe(
      "C:\\Users\\fabian\\OneDrive\\Downloads",
    );
  });

  it("gives up on an unknown variable or missing value", () => {
    expect(windowsDownloadDir(REG_OUTPUT, {})).toBeUndefined();
    expect(windowsDownloadDir(undefined, {})).toBeUndefined();
  });
});

describe("downloadsDirectory", () => {
  it("uses ~/Downloads on macOS without looking further", () => {
    expect(
      downloadsDirectory({
        platform: "darwin",
        home: "/Users/fabian",
        env: { XDG_DOWNLOAD_DIR: "/elsewhere" },
        exists: () => true,
      }),
    ).toBe("/Users/fabian/Downloads");
  });

  it("uses the XDG folder on Linux when it exists", () => {
    expect(
      downloadsDirectory({
        platform: "linux",
        home: HOME,
        env: {},
        readFile: () => USER_DIRS,
        exists: (path) => path === `${HOME}/Herunterladen`,
      }),
    ).toBe(`${HOME}/Herunterladen`);
  });

  it("uses the moved known folder on Windows", () => {
    expect(
      downloadsDirectory({
        platform: "win32",
        home: "C:\\Users\\fabian",
        env: { USERPROFILE: "C:\\Users\\fabian" },
        queryRegistry: () => REG_OUTPUT,
        exists: () => true,
      }),
    ).toBe("C:\\Users\\fabian\\OneDrive\\Downloads");
  });

  it("falls back to ~/Downloads when the configured folder is missing", () => {
    expect(
      downloadsDirectory({
        platform: "linux",
        home: HOME,
        env: {},
        readFile: () => USER_DIRS,
        exists: () => false,
      }),
    ).toBe(`${HOME}/Downloads`);
  });
});
