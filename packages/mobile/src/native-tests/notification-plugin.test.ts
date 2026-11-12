import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { IOSConfig, type ConfigPlugin, type ExportedConfig } from "expo/config-plugins";
import { expect, it } from "vitest";
import { projectFixture } from "./xcode-project.fixture";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const pluginRequire = createRequire(expoRequire.resolve("@expo/config-plugins"));
const { default: plist }: { default: { parse: (text: string) => unknown } } =
  pluginRequire("@expo/plist");
const withNotificationDecryption: (
  config: Parameters<ConfigPlugin>[0],
) => ExportedConfig = require("../../plugins/withNotificationDecryption.cjs");

it.each(["app.jyu.nodex.mobile.dev", "app.jyu.nodex.mobile"])(
  "generates and preserves a signed extension for %s",
  async (bundleId) => {
    const directory = await mkdtemp(path.join(tmpdir(), "nodex-notification-plugin-"));
    try {
      const ios = path.join(directory, "ios");
      const xcodeDirectory = path.join(ios, "Nodex.xcodeproj");
      await mkdir(xcodeDirectory, { recursive: true });
      await writeFile(path.join(xcodeDirectory, "project.pbxproj"), projectFixture);
      const project = IOSConfig.XcodeUtils.getPbxproj(directory);
      Object.assign(project.hash.project.objects, { PBXBuildFile: {}, PBXFileReference: {} });
      let config = withNotificationDecryption({
        name: "Nodex",
        slug: "nodex",
        version: "0.2.3",
        ios: { bundleIdentifier: bundleId, appleTeamId: "TEAM123456", buildNumber: "42" },
      });
      // Default Expo mods run before user mods, when the extension does not yet exist.
      config = IOSConfig.DevelopmentTeam.withDevelopmentTeam(config);
      const modRequest = {
        projectRoot: directory,
        platformProjectRoot: ios,
        platform: "ios" as const,
        modName: "xcodeproj",
        introspect: false,
      };
      for (let iteration = 0; iteration < 2; iteration++) {
        await config.mods!.ios!.dangerous!({
          ...config,
          modRequest,
          modRawConfig: config,
          modResults: null,
        });
        await config.mods!.ios!.xcodeproj!({
          ...config,
          modRequest,
          modRawConfig: config,
          modResults: project,
        });
      }
      const targets = IOSConfig.Target.getNativeTargets(project);
      expect(targets).toHaveLength(2);
      const extension = targets.find(([, target]) =>
        String(target.name).includes("NotificationService"),
      )![1];
      const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
        project,
        extension.buildConfigurationList,
      );
      for (const [, { buildSettings }] of configurations) {
        expect(buildSettings).toMatchObject({
          PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.NotificationService"`,
          DEVELOPMENT_TEAM: "TEAM123456",
          CODE_SIGN_STYLE: "Automatic",
          MARKETING_VERSION: "0.2.3",
          CURRENT_PROJECT_VERSION: "42",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          APPLICATION_EXTENSION_API_ONLY: "YES",
          CODE_SIGN_ENTITLEMENTS: "NotificationService/NotificationService.entitlements",
          NODEX_PUSH_KEYCHAIN_GROUP: `"$(AppIdentifierPrefix)${bundleId}.push"`,
        });
      }
      const entitlements = await config.mods!.ios!.entitlements!({
        ...config,
        modRequest,
        modRawConfig: config,
        modResults: { "keychain-access-groups": ["other.group"] },
      });
      expect(entitlements.modResults["keychain-access-groups"]).toEqual([
        "other.group",
        `$(AppIdentifierPrefix)${bundleId}.push`,
      ]);
      const copyPhases = Object.values(project.hash.project.objects.PBXCopyFilesBuildPhase).filter(
        (value) => typeof value === "object",
      );
      expect(copyPhases).toHaveLength(1);
      expect(copyPhases[0]).toMatchObject({ dstSubfolderSpec: 13, files: [expect.anything()] });
      const readPlist = async (file: string) =>
        plist.parse(await readFile(path.join(ios, "NotificationService", file), "utf8"));
      expect(await readPlist("NotificationService.entitlements")).toEqual({
        "keychain-access-groups": [`$(AppIdentifierPrefix)${bundleId}.push`],
      });
      expect(await readPlist("Info.plist")).toMatchObject({
        CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
        CFBundleShortVersionString: "$(MARKETING_VERSION)",
        CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
        NodexPushKeychainGroup: "$(NODEX_PUSH_KEYCHAIN_GROUP)",
        NSExtension: {
          NSExtensionPointIdentifier: "com.apple.usernotifications.service",
          NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
