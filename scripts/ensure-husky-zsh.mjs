import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const runnerPath = path.join(process.cwd(), ".husky", "_", "h");

let content;
try {
  content = readFileSync(runnerPath, "utf8");
} catch {
  console.warn(
    "ensure-husky-zsh: .husky/_/h not found (run pnpm exec husky first)",
  );
  process.exit(0);
}

const next = content
  .replace(/^#!\/usr\/bin\/env sh$/m, "#!/usr/bin/env zsh")
  .replace(/\bsh -e "\$s"/, 'zsh -e "$s"');

if (next === content) {
  console.log("ensure-husky-zsh: runner already uses zsh");
  process.exit(0);
}

writeFileSync(runnerPath, next);
console.log("ensure-husky-zsh: configured .husky/_/h to run hooks with zsh");
