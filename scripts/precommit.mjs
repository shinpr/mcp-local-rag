import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  ensureCompatibleNodeOrReexec,
  getCorepackCommand,
  getToolEnv,
} from "./compatible-node.mjs";

ensureCompatibleNodeOrReexec();

const fromHook = process.argv.includes("--from-hook");
const corepack = getCorepackCommand();
const useShell = process.platform === "win32";
const env = getToolEnv();

function pnpm(args, options = {}) {
  r(corepack, ["pnpm", ...args], options);
}

function r(command, args, options = {}) {
  console.log(`\n=== Running: ${command} ${args.join(" ")} ===`);
  const { allowFailure, ...spawnOptions } = options;
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: useShell,
    env,
    ...spawnOptions,
  });
  if (result.status !== 0 && !allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function runCapture(command, args) {
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
  return spawnSync(command, args, {
    shell: useShell,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

function getStagedFiles() {
  const result = runCapture("git", [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACM",
  ]);

  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return (result.stdout || "")
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function commandExists(command) {
  const result = runCapture("zsh", ["-lc", `command -v ${command}`]);
  return result.status === 0;
}

const stagedFiles = getStagedFiles();
const hasWorkflowChanges = stagedFiles.some((file) =>
  file.startsWith(".github/workflows/"),
);
const hasFrontendChanges = stagedFiles.some((file) =>
  file.startsWith("frontend/src/"),
);

if (hasWorkflowChanges) {
  if (commandExists("yamllint") || commandExists("act")) {
    r("zsh", ["scripts/check-workflows.sh"]);
  } else {
    console.log(
      "\n=== Workflow checks skipped (install yamllint or act to validate .github/workflows) ===",
    );
  }
}

if (!fromHook) {
  pnpm(["exec", "biome", "check", "--write", "src"]);
}

pnpm(["run", "type-check"]);

if (hasFrontendChanges) {
  pnpm(["--dir", "frontend", "exec", "tsc", "-b", "--noEmit"]);
}

console.log("\n=== Pre-commit checks passed ===");
