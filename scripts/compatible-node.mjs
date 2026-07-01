import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

/** Matches pnpm 11+ (requires Node 22.13+ for built-in node:sqlite). */
const MIN_NODE_22 = [22, 13, 0];

function parseVersion(value) {
  const match = value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function isCompatibleVersion(version) {
  if (version[0] === 22) return compareVersions(version, MIN_NODE_22) >= 0;
  return version[0] > 22;
}

function findCompatibleNvmNode() {
  const nvmDir = process.env.NVM_DIR ?? path.join(homedir(), ".nvm");
  const versionsDir = path.join(nvmDir, "versions", "node");

  if (!existsSync(versionsDir)) return null;

  const candidates = readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      version: parseVersion(entry.name),
      binary: path.join(versionsDir, entry.name, "bin", "node"),
    }))
    .filter(
      (entry) =>
        entry.version &&
        isCompatibleVersion(entry.version) &&
        existsSync(entry.binary),
    );

  const preferredMajor = [22];
  for (const major of preferredMajor) {
    const match = candidates
      .filter((entry) => entry.version[0] === major)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (match) return match.binary;
  }

  return (
    candidates
      .filter((entry) => entry.version[0] > 22)
      .sort((a, b) => compareVersions(a.version, b.version))[0]?.binary ?? null
  );
}

export function ensureCompatibleNodeOrReexec() {
  const current = parseVersion(process.version);
  if (current && isCompatibleVersion(current)) return;

  if (process.env.COMPATIBLE_NODE_REEXEC === "1") {
    console.error(
      `Node ${process.version} is not supported. Use Node 22.13+ (pnpm 11 requirement) to run project tooling.`,
    );
    process.exit(1);
  }

  const fallbackNode = findCompatibleNvmNode();
  if (!fallbackNode) {
    console.error(
      `Node ${process.version} is not supported. Install or activate Node 22.13+ before running project tooling.`,
    );
    process.exit(1);
  }

  const env = {
    ...process.env,
    COMPATIBLE_NODE_REEXEC: "1",
    PATH: `${path.dirname(fallbackNode)}${path.delimiter}${process.env.PATH ?? ""}`,
  };

  const result = spawnSync(fallbackNode, process.argv.slice(1), {
    stdio: "inherit",
    env,
  });

  process.exit(result.status ?? 1);
}

export function getToolEnv() {
  const nodeDir = path.dirname(process.execPath);
  const nodeBinDir = path.join(process.cwd(), "node_modules", ".bin");

  return {
    ...process.env,
    PATH: `${nodeDir}${path.delimiter}${nodeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

export function getCorepackCommand() {
  const bundledCorepack = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "corepack.cmd" : "corepack",
  );
  return existsSync(bundledCorepack) ? bundledCorepack : "corepack";
}
