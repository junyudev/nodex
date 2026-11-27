import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import {
  materializeAgentRuntimeNative,
  agentRuntimeNativeBuildEnvironment,
} from "./agent-runtime-native";
import { verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

vi.mock("./standalone-node-runtime", () => ({
  assertStandaloneNodeRuntime: () => ({
    executable: process.execPath,
    version: process.versions.node,
  }),
}));

test.skipIf(process.platform !== "win32")(
  "loads a private matching Windows N-API closure independently of Electron",
  () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-windows-pty-"));
    const require = createRequire(import.meta.url);
    try {
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "pnpm-lock.yaml"), "fixture");
      mkdirSync(join(root, "node_modules"));
      for (const name of ["node-pty", "node-gyp"])
        symlinkSync(
          dirname(require.resolve(`${name}/package.json`)),
          join(root, "node_modules", name),
          "junction",
        );
      const native = materializeAgentRuntimeNative(root);
      expect(native.node.architecture).toBe(process.arch);
      expect(materializeAgentRuntimeNative(root)).toEqual(native);
      expect(
        verifyWindowsArchitectureClosure(native.packageRoot, process.arch as "x64" | "arm64", {
          nodeHost: process.execPath,
        }).length,
      ).toBeGreaterThan(3);
      execFileSync(process.execPath, ["-e", "require(process.argv[1])", native.packageRoot]);
      const before = readFileSync(require.resolve("node-pty/package.json"));
      writeFileSync(join(native.packageRoot, "build/Release/conpty.node"), "damaged");
      const repaired = materializeAgentRuntimeNative(root);
      execFileSync(process.execPath, ["-e", "require(process.argv[1])", repaired.packageRoot]);
      expect(readFileSync(require.resolve("node-pty/package.json"))).toEqual(before);
      const environment = agentRuntimeNativeBuildEnvironment(native.node, {
        PATH: "other",
        npm_config_runtime: "electron",
        NODE_OPTIONS: "--require=foreign.cjs",
      });
      expect(environment.npm_config_runtime).toBeUndefined();
      expect(environment.NODE_OPTIONS).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
