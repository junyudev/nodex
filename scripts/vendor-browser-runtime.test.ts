import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS } from "../src/shared/browser-runtime-metadata";
import {
  browserPluginNodeModuleDirs,
  readCuaRuntimeVersion,
  readMachOMinimumMacosVersion,
  readSkyNativeExports,
} from "./vendor-browser-runtime";

const temporaryRoots: string[] = [];

function writeAddon(exports: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-sky-exports-"));
  temporaryRoots.push(root);
  const addonPath = path.join(root, "sky.cjs");
  fs.writeFileSync(
    addonPath,
    `module.exports = {${exports.map((name) => `${JSON.stringify(name)}() {}`).join(",")}};\n`,
  );
  return addonPath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("declares the vendored Browser plugin dependency directory", () => {
  expect(browserPluginNodeModuleDirs()).toEqual([
    "runtime/lib/node_modules",
    "marketplace/plugins/browser/node_modules",
  ]);
});

describe("readCuaRuntimeVersion", () => {
  test("reads the unified CUA runtime version used by current desktop builds", () => {
    expect(
      readCuaRuntimeVersion({
        runtime_archive_version: "0.0.6/current",
        node_repl_archive_path: "legacy",
      }),
    ).toBe("0.0.6/current");
  });

  test("requires the current runtime manifest field", () => {
    expect(() =>
      readCuaRuntimeVersion({
        node_repl_archive_path: "legacy",
      }),
    ).toThrow("CUA runtime version");
  });
});

test("records the selected Chrome host architecture's actual deployment target", () => {
  expect(
    readMachOMinimumMacosVersion("/signed/ChatGPT for Chrome", "x64", (command, args) => {
      expect(command).toBe("/usr/bin/otool");
      expect(args).toEqual(["-arch", "x86_64", "-l", "/signed/ChatGPT for Chrome"]);
      return `
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.12
      sdk 15.5
`;
    }),
  ).toBe("10.12");
});

describe("sky.node ABI vendoring", () => {
  test("records every function export in stable sorted order", () => {
    const required = Object.values(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS).flat();
    const expected = [...new Set(["futureNativeCapability", ...required])].sort();

    expect(readSkyNativeExports(process.execPath, writeAddon(expected.toReversed()))).toEqual(
      expected,
    );
  });

  test("rejects an add-on missing a required capability export", () => {
    const required = Object.values(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS).flat();
    const incomplete = required.filter(
      (name) => name !== "setRemoteHostedPIPContentLayoutStateChangedHandler",
    );

    expect(() => readSkyNativeExports(process.execPath, writeAddon(incomplete))).toThrow(
      "setRemoteHostedPIPContentLayoutStateChangedHandler",
    );
  });
});
