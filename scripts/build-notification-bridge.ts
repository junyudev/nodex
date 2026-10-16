import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildNativeBridge } from "./build-native-bridge";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildNotificationBridge(architecture: "arm64"): void {
  buildNativeBridge({
    architecture,
    name: "notifications",
    script: "scripts/build-notification-bridge.ts",
    repositoryRoot,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const architecture = process.argv[2] ?? process.arch;
  if (architecture !== "arm64") throw new Error("Expected arm64");
  buildNotificationBridge(architecture);
}
