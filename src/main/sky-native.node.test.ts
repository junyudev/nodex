import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS } from "../shared/browser-runtime-metadata";
import {
  inspectSkyNativeCapabilities,
  loadSkyNativeAddon,
  matchesSkyNativeExportContract,
} from "./sky-native";

function addonExports(): Record<string, () => void> {
  return Object.fromEntries(
    Object.values(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS)
      .flat()
      .map((name) => [name, () => undefined]),
  );
}

describe("sky native contract", () => {
  test("reports independently verified capability groups", () => {
    const exports = addonExports();
    expect(inspectSkyNativeCapabilities(exports)).toEqual({
      computerUseService: true,
      hostLayout: true,
      interaction: true,
      presentation: true,
    });

    delete exports.connectRemoteHostedPIPContentHost;
    expect(inspectSkyNativeCapabilities(exports)).toEqual({
      computerUseService: false,
      hostLayout: true,
      interaction: true,
      presentation: true,
    });
  });

  test("does not search ambient application or resources directories", () => {
    expect(loadSkyNativeAddon()).toBeNull();
    expect(loadSkyNativeAddon("relative/native/sky.node")).toBeNull();
  });

  test("admits only callable capability groups and the exact verified export set on every host", () => {
    const addon = addonExports();
    const exports = Object.keys(addon);
    expect(matchesSkyNativeExportContract(addon, exports)).toBe(true);
    expect(matchesSkyNativeExportContract(addon, [...exports, "unexpectedExport"])).toBe(false);
    expect(
      matchesSkyNativeExportContract({ ...addon, unexpectedExport: () => undefined }, exports),
    ).toBe(false);
    expect(
      matchesSkyNativeExportContract(
        { ...addon, connectRemoteHostedPIPContentHost: null },
        exports,
      ),
    ).toBe(false);
    expect(matchesSkyNativeExportContract(addon, [])).toBe(false);
  });

  test("loads verified exports only on macOS", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-sky-loader-"));
    try {
      const exports = Object.keys(addonExports()).sort();
      const addonPath = path.join(root, "sky.cjs");
      fs.writeFileSync(
        addonPath,
        `module.exports = {${exports.map((name) => `${JSON.stringify(name)}() {}`).join(",")}};\n`,
      );

      const loaded = loadSkyNativeAddon(addonPath, exports);
      if (process.platform === "darwin") expect(loaded).not.toBeNull();
      else expect(loaded).toBeNull();
      expect(loadSkyNativeAddon(addonPath, [...exports, "unexpectedExport"])).toBeNull();
      expect(loadSkyNativeAddon(addonPath)).toBeNull();
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
