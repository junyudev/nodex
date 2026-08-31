import fs from "node:fs";
import path from "node:path";

import { load } from "js-yaml";
import { describe, expect, test } from "vite-plus/test";

interface ElectronBuilderFileSet {
  readonly filter?: readonly string[];
  readonly from?: string;
  readonly to?: string;
}

interface ElectronBuilderConfig {
  readonly afterPack?: string;
  readonly dmg?: {
    readonly sign?: boolean;
    readonly writeUpdateInfo?: boolean;
  };
  readonly extraFiles?: readonly ElectronBuilderFileSet[];
  readonly extraResources?: readonly ElectronBuilderFileSet[];
  readonly mac?: {
    readonly binaries?: readonly string[];
    readonly entitlements?: string;
    readonly entitlementsInherit?: string;
    readonly extendInfo?: Record<string, unknown>;
    readonly hardenedRuntime?: boolean;
    readonly minimumSystemVersion?: string;
    readonly sign?: string;
    readonly target?: readonly string[];
  };
  readonly publish?: unknown;
}

function readBooleanPlist(filePath: string): Readonly<Record<string, boolean>> {
  const source = fs.readFileSync(filePath, "utf8");
  const entries = [...source.matchAll(/<key>\s*([^<]+?)\s*<\/key>\s*<(true|false)\s*\/>/gu)];
  const keyCount = [...source.matchAll(/<key>/gu)].length;
  if (entries.length !== keyCount) {
    throw new Error(`Expected a boolean-only entitlement plist: ${filePath}`);
  }

  const result: Record<string, boolean> = {};
  for (const [, key, value] of entries) {
    if (!key || !value || Object.hasOwn(result, key)) {
      throw new Error(`Invalid or duplicate entitlement key in ${filePath}`);
    }
    result[key] = value === "true";
  }
  return result;
}

function readStringPlistValue(filePath: string, key: string): string {
  const source = fs.readFileSync(filePath, "utf8");
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(
    new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`, "u"),
  );
  if (!match?.[1]) throw new Error(`Missing string plist key ${key} in ${filePath}`);
  return match[1];
}

describe("electron-builder runtime resources", () => {
  test("mounts the exact Agent runtime and Skill artifacts at Resources", () => {
    const configPath = path.resolve("electron-builder.yml");
    const config = load(fs.readFileSync(configPath, "utf8")) as ElectronBuilderConfig;

    expect(config.afterPack).toBe("scripts/restore-packaged-runtime-closure.mjs");
    expect(config.extraResources).toContainEqual({
      from: ".generated/codex-runtime/agent-runtime",
      to: ".",
      filter: ["**/*"],
    });
    expect(config.extraResources).toContainEqual({
      from: ".generated/official-agent-skills",
      to: "agent-skills",
      filter: ["**/*"],
    });
    expect(config.extraResources).toContainEqual({
      from: ".generated/sparkle-runtime/${arch}/nodex-sparkle.node",
      to: "native/nodex-sparkle.node",
    });
    expect(config.extraResources).toEqual(
      expect.arrayContaining([
        {
          from: ".generated/build-resources/THIRD_PARTY_NOTICES.txt",
          to: "THIRD_PARTY_NOTICES.txt",
        },
      ]),
    );
    expect(config.extraFiles).toContainEqual({
      from: ".generated/sparkle-runtime/${arch}/Sparkle.framework",
      to: "Frameworks/Sparkle.framework",
      filter: ["**/*"],
    });
    expect(config.mac?.binaries).not.toContain("Contents/Resources/bin/codex-app-server");
    expect(config.mac?.binaries).not.toContain("Contents/Resources/bin/codex-code-mode-host");
    expect(config.mac?.binaries).not.toContain("Contents/Resources/codex-path/rg");
    expect(config.mac?.binaries).not.toContain("Contents/Resources/codex-resources/zsh/bin/zsh");
    expect(config.mac?.binaries).not.toContain("Contents/Resources/bin/interpreter");
    expect(config.mac?.binaries).not.toContain("Contents/Resources/bin/rg");
    expect(
      config.mac?.binaries?.some((entry) => entry.startsWith("Contents/Resources/agent-runtime/")),
    ).toBe(false);
    expect(config.mac?.target).toEqual(["dmg"]);
    expect(config.mac?.minimumSystemVersion).toBe("15.0.0");
    expect(config.mac?.extendInfo).toMatchObject({
      SUPublicEDKey: "YNySLZ74gjVAOpEdMo9OOEPvuTEMZf8fMnI+oQD7Ifs=",
      SURequireSignedFeed: true,
      SUVerifyUpdateBeforeExtraction: true,
    });
    expect(config.dmg).toMatchObject({ sign: true, writeUpdateInfo: false });
    expect(config.publish).toBeUndefined();
  });

  test("grants microphone capture only to the hardened top-level app", () => {
    const configPath = path.resolve("electron-builder.yml");
    const config = load(fs.readFileSync(configPath, "utf8")) as ElectronBuilderConfig;
    const mainEntitlementsPath = config.mac?.entitlements;
    const inheritedEntitlementsPath = config.mac?.entitlementsInherit;

    expect(config.mac).toMatchObject({
      hardenedRuntime: true,
      sign: "scripts/sign-macos-runtime.mjs",
    });
    expect(mainEntitlementsPath).toBe("resources/entitlements.mac.plist");
    expect(inheritedEntitlementsPath).toBe("resources/entitlements.mac.inherit.plist");
    expect(mainEntitlementsPath).not.toBe(inheritedEntitlementsPath);
    expect(config.mac?.extendInfo?.NSMicrophoneUsageDescription).toBe(
      "Nodex uses your microphone for dictation.",
    );
    if (!mainEntitlementsPath || !inheritedEntitlementsPath) {
      throw new Error("macOS entitlement paths are required");
    }

    const mainEntitlements = readBooleanPlist(path.resolve(mainEntitlementsPath));
    const inheritedEntitlements = readBooleanPlist(path.resolve(inheritedEntitlementsPath));
    expect(mainEntitlements["com.apple.security.device.audio-input"]).toBe(true);
    expect(inheritedEntitlements).not.toHaveProperty("com.apple.security.device.audio-input");
    expect(mainEntitlements).not.toHaveProperty("com.apple.security.device.microphone");
    expect(inheritedEntitlements).not.toHaveProperty("com.apple.security.device.microphone");
  });

  test("keeps the nested background service on the product macOS baseline", () => {
    expect(
      readStringPlistValue(
        path.resolve("resources/macos/nodex-service-Info.plist"),
        "LSMinimumSystemVersion",
      ),
    ).toBe("15.0");
  });
});
