import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildIdentity } from "./release/model";
import { APP_UPDATE_PUBLIC_KEY } from "../src/main/app-update-trust";
import { windowsUpdateFeedUrls } from "../src/main/windows-app-update-config";

/** Uses the same release inputs as Sparkle and prepared Electron output. */
export function windowsUpdateManifest(
  architecture: "x64" | "arm64",
  environment: NodeJS.ProcessEnv,
) {
  const updates = environment.NODEX_APP_UPDATES ?? "disabled";
  const identity = environment.NODEX_BUILD_IDENTITY_PATH
    ? parseBuildIdentity(JSON.parse(readFileSync(environment.NODEX_BUILD_IDENTITY_PATH, "utf8")))
    : null;
  if (updates !== "disabled" && updates !== "enabled") {
    throw new Error("NODEX_APP_UPDATES must be disabled or enabled.");
  }
  if (updates === "enabled" && !identity) {
    throw new Error("Enabled Windows updates require a Build Identity.");
  }
  return {
    schemaVersion: 1,
    architecture,
    updates,
    buildVersion: identity?.buildVersion ?? "0.0.0",
    feedUrls: updates === "disabled" ? null : windowsUpdateFeedUrls(architecture),
    publicKey: APP_UPDATE_PUBLIC_KEY,
  };
}

export function stageWindowsUpdateManifest(root: string, architecture: "x64" | "arm64"): void {
  const directory = join(root, ".generated/windows-updater", architecture);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "app-update.json"),
    `${JSON.stringify(windowsUpdateManifest(architecture, process.env), null, 2)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const architecture = process.argv[2];
  if (architecture !== "x64" && architecture !== "arm64")
    throw new Error("Usage: windows-update-manifest.ts <x64|arm64>");
  stageWindowsUpdateManifest(process.cwd(), architecture);
}
