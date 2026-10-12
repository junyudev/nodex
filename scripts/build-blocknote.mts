import { execFileSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageNames = ["core", "react", "shadcn", "math-block", "diagram-block", "code-block"];
const packagesDirectory = realpathSync(
  fileURLToPath(new URL("../third_party/blocknote/packages/", import.meta.url)),
);
const currentPackage = relative(packagesDirectory, realpathSync(process.cwd()));
if (!packageNames.includes(currentPackage)) {
  throw new Error("Run this build from a BlockNote package in the current worktree.");
}

/** A package build owns its complete declaration and bundle output directories. */
rmSync("types", { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("./bin/tsc-rs", import.meta.resolve("tsc-rs/package.json"))),
    "--project",
    "tsconfig.build.json",
    "--composite",
    "false",
    "--incremental",
    "false",
  ],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./bin/vp", import.meta.resolve("vite-plus/package.json"))), "build"],
  { stdio: "inherit" },
);
