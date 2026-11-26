import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

export function resolveMediaStore(cwd: string): string {
  const override = process.env.NODEX_MEDIA_STORE;
  if (override) return resolve(cwd, override);
  const commonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).replace(/\r?\n$/u, "");
  return join(dirname(commonDir), "notes.local", "media", "sha256");
}
