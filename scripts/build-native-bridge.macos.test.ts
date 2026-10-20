import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { parseOtoolMinimumMacosVersion } from "./agent-runtime-macos-platform-contract";
import { buildNativeBridge } from "./build-native-bridge";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64").each([
  { name: "clipboard", script: "scripts/build-clipboard-bridge.ts" },
  { name: "devicecheck", script: "scripts/build-devicecheck-bridge.ts" },
  { name: "notifications", script: "scripts/build-notification-bridge.ts" },
] as const)(
  "compiles $name against the product deployment target with Electron headers",
  ({ name, script }) => {
    const root = mkdtempSync(path.join(tmpdir(), `nodex-${name}-target-`));
    try {
      for (const file of [
        "package.json",
        "pnpm-lock.yaml",
        script,
        `native/macos-${name}/binding.gyp`,
        `native/macos-${name}/src/nodex_${name}.mm`,
      ]) {
        const destination = path.join(root, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(repositoryRoot, file), destination);
      }
      buildNativeBridge({ architecture: "arm64", name, script, repositoryRoot: root });
      const binary = path.join(root, ".generated", `${name}-runtime/arm64/nodex-${name}.node`);
      expect(execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim()).toBe(
        "arm64",
      );
      expect(
        parseOtoolMinimumMacosVersion(
          execFileSync("/usr/bin/otool", ["-l", binary], { encoding: "utf8" }),
        ),
      ).toBe("15.0");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
