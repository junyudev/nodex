import { createRequire } from "node:module";
import path from "node:path";
import type { CodexDeviceCheckResult } from "../../codex-application/CodexAttestation";

export interface NativeDeviceCheckBridge {
  readonly isSupported: () => boolean;
  readonly generateToken: () => Promise<CodexDeviceCheckResult>;
}

const require = createRequire(import.meta.url);

export const loadNativeDeviceCheckBridge = (options: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly architecture: string;
}): NativeDeviceCheckBridge => {
  const bindingPath = options.packaged
    ? path.join(options.resourcesPath, "native", "nodex-devicecheck.node")
    : path.join(
        options.appPath,
        ".generated",
        "devicecheck-runtime",
        options.architecture,
        "nodex-devicecheck.node",
      );
  return require(bindingPath) as NativeDeviceCheckBridge;
};
