#!/usr/bin/env node
// Packs the Claude Desktop extension (eule-mcp.mcpb) for every platform from
// the built dist/ and the release eule-helper binaries:
//
//   node scripts/pack-mcpb.mjs --helpers <dir> [--all] [--out release-mcpb]
//
// <dir> holds release assets named eule-helper-<target>[.exe]; each one with a
// .sha256 sidecar is verified against it. --all fails unless all five targets
// are present (the release uses it; local and CI dry runs pack what they have).
//
// The bundle contains dist/, a production-only node_modules installed from the
// lockfile without install scripts (better-sqlite3 loads its N-API prebuild for
// whichever platform it runs on), and each helper at bin/<target>/, where
// src/helper/download.ts finds it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

// Release asset suffixes; the bundle directory names match bundledHelperDir().
const TARGETS = ["darwin-universal", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];

// Non-runtime files in dependencies. A leading "/" would anchor to the bundle
// root; these patterns deliberately apply inside node_modules only.
const MCPBIGNORE = `node_modules/**/*.md
node_modules/**/*.markdown
node_modules/**/*.d.ts
node_modules/**/*.d.cts
node_modules/**/*.d.mts
node_modules/**/*.map
node_modules/**/*.ts.map
node_modules/**/test/
node_modules/**/tests/
node_modules/**/__tests__/
node_modules/**/docs/
node_modules/**/example/
node_modules/**/examples/
node_modules/**/.github/
node_modules/.modules.yaml
node_modules/.pnpm/
/.mcpbignore
/pnpm-lock.yaml
/pnpm-workspace.yaml
`;

const { values } = parseArgs({
  options: {
    helpers: { type: "string" },
    all: { type: "boolean", default: false },
    out: { type: "string", default: "release-mcpb" },
  },
});

if (!values.helpers) {
  console.error("Usage: node scripts/pack-mcpb.mjs --helpers DIR [--all] [--out DIR]");
  process.exit(2);
}

const repo = resolve(import.meta.dirname, "..");
const helperDir = resolve(values.helpers);
const outDir = resolve(values.out);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// pnpm is a .cmd shim on Windows, which only a shell can start.
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
const MCPB_CLI = join(repo, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version)
  throw new Error(`manifest.json ${manifest.version} != package.json ${pkg.version}`);
if (!existsSync(join(repo, manifest.server.entry_point)))
  throw new Error(`${manifest.server.entry_point} is missing; run "pnpm run build" first`);
const helpers = [];
for (const target of TARGETS) {
  const file = `eule-helper-${target}${target.startsWith("win32-") ? ".exe" : ""}`;
  const path = join(helperDir, file);
  if (!existsSync(path)) {
    if (values.all) throw new Error(`Helper not found: ${path}`);
    console.warn(`Skipping ${target}: no ${file}`);
    continue;
  }
  if (existsSync(`${path}.sha256`)) {
    const expected = readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (sha256(path) !== expected?.toLowerCase()) throw new Error(`Checksum mismatch for ${path}`);
  }
  helpers.push({
    target,
    path,
    name: file.startsWith("eule-helper-win32") ? "eule-helper.exe" : "eule-helper",
  });
}
if (helpers.length === 0) throw new Error(`No eule-helper-* binaries in ${helperDir}`);

const stage = mkdtempSync(join(tmpdir(), "eule-mcpb-"));
try {
  cpSync(join(repo, "dist"), join(stage, "dist"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
  });
  for (const file of ["LICENSE", "README.md", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
    copyFileSync(join(repo, file), join(stage, file));
  copyFileSync(join(repo, "assets", "icon.png"), join(stage, "icon.png"));
  writeFileSync(join(stage, ".mcpbignore"), MCPBIGNORE);

  // The lockfile still lists the devDependencies, so they stay declared for a
  // frozen install and are removed afterwards. No scripts: "prepare" would run
  // lefthook, which is neither installed nor wanted here.
  const stagedPkg = { ...pkg };
  delete stagedPkg.scripts;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);
  run(
    "pnpm",
    [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
      "--config.confirmModulesPurge=false",
    ],
    stage,
  );
  delete stagedPkg.devDependencies;
  delete stagedPkg.packageManager;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);
  rmSync(join(stage, "node_modules", ".bin"), { recursive: true, force: true });

  // better-sqlite3 runs from its prebuilds; its sources are only for node-gyp.
  const sqlite = join(stage, "node_modules", "better-sqlite3");
  for (const dir of ["deps", "src", "build"])
    rmSync(join(sqlite, dir), { recursive: true, force: true });
  rmSync(join(sqlite, "binding.gyp"), { force: true });

  for (const { target, path, name } of helpers) {
    mkdirSync(join(stage, "bin", target), { recursive: true });
    copyFileSync(path, join(stage, "bin", target, name));
    chmodSync(join(stage, "bin", target, name), 0o755);
  }
  copyFileSync(join(repo, "manifest.json"), join(stage, "manifest.json"));

  mkdirSync(outDir, { recursive: true });
  const bundle = join(outDir, "eule-mcp.mcpb");
  execFileSync(process.execPath, [MCPB_CLI, "pack", stage, bundle], {
    cwd: repo,
    stdio: "inherit",
  });
  writeFileSync(`${bundle}.sha256`, `${sha256(bundle)}  ${basename(bundle)}\n`);
  console.log(`Packed ${bundle} with helpers for ${helpers.map((h) => h.target).join(", ")}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
