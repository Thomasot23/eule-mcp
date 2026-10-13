#!/usr/bin/env node
// Smoke-tests eule-mcp.mcpb on the machine it runs on: unpacks it into an
// empty directory, checks that Eule resolves this platform's bundled helper and
// that the helper starts, then starts the server with a throwaway HOME (so
// ~/.eule is never touched) and checks the MCP handshake and tool list.
// --all also requires the helpers for every other platform.
//
//   node scripts/verify-mcpb.mjs release-mcpb/eule-mcp.mcpb [--all]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values, positionals } = parseArgs({
  options: { all: { type: "boolean", default: false } },
  allowPositionals: true,
});
const bundle = positionals[0] && resolve(positionals[0]);
if (!bundle) {
  console.error("Usage: node scripts/verify-mcpb.mjs BUNDLE.mcpb [--all]");
  process.exit(2);
}
const TARGETS = ["darwin-universal", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
// Same naming as bundledHelperDir() in src/helper/download.ts.
const hostTarget =
  process.platform === "darwin" ? "darwin-universal" : `${process.platform}-${process.arch}`;
const windowsTar = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

const helperFile = (target) =>
  join(target, target.startsWith("win32-") ? "eule-helper.exe" : "eule-helper");

const root = realpathSync(mkdtempSync(join(tmpdir(), "eule-mcpb-root-")));
const home = mkdtempSync(join(tmpdir(), "eule-mcpb-home-"));
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.EULE_HELPER_PATH;

try {
  // Windows has no unzip, but its bsdtar reads zip archives. Called by full
  // path: in Git Bash, GNU tar comes first on PATH and takes the drive letter
  // of "D:\a\..." for a remote host ("Cannot connect to D: resolve failed").
  if (process.platform === "win32") execFileSync(windowsTar(), ["-xf", bundle, "-C", root]);
  else execFileSync("unzip", ["-qq", bundle, "-d", root]);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.version !== pkg.version)
    throw new Error(`manifest ${manifest.version} != package ${pkg.version}`);
  if (pkg.devDependencies || pkg.scripts) throw new Error("package.json is not runtime-only");

  for (const target of values.all ? TARGETS : [hostTarget])
    if (!existsSync(join(root, "bin", helperFile(target))))
      throw new Error(`Bundle has no helper for ${target}`);

  const helper = join(root, "bin", helperFile(hostTarget));
  const resolved = execFileSync(
    process.execPath,
    [join(root, "dist/cli/index.js"), "helper-path"],
    {
      cwd: root,
      env,
      encoding: "utf8",
    },
  ).trim();
  if (resolved !== helper) throw new Error(`Eule resolves ${resolved}, expected ${helper}`);
  // On Linux this also needs the WebKitGTK runtime libraries.
  const helperVersion = execFileSync(helper, ["--version"], { encoding: "utf8" }).trim();
  if (helperVersion !== `eule-helper ${pkg.version}`)
    throw new Error(`Bundled helper reports "${helperVersion}", expected ${pkg.version}`);
  console.log(`helper: ${resolved} (${helperVersion})`);

  const args = manifest.server.mcp_config.args.map((arg) => arg.replace("${__dirname}", root));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "verify-mcpb", version: "0" });
  await client.connect(transport);
  const info = client.getServerVersion();
  if (info?.name !== "eule" || info.version !== pkg.version)
    throw new Error(`serverInfo ${JSON.stringify(info)}, expected eule ${pkg.version}`);
  const { tools } = await client.listTools();
  if (tools.length === 0) throw new Error("Server lists no tools");
  await client.close();
  console.log(`serverInfo: ${info.name} ${info.version}, ${tools.length} tools`);
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
