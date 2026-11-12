import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AndroidConfig,
  IOSConfig,
  withPlugins,
  type ExportedConfig,
  type Mod,
} from "expo/config-plugins";
import { afterEach, expect, it, vi } from "vitest";
import { projectFixture } from "./xcode-project.fixture";

const mobile = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const sharingRequire = createRequire(require.resolve("expo-sharing/package.json"));
const { default: plist }: { default: { parse: (text: string) => unknown } } =
  sharingRequire("@expo/plist");
const groupKey = "com.apple.security.application-groups";
const unquote = (value: string) => value.replace(/^"|"$/g, "");

afterEach(() => vi.unstubAllEnvs());

async function loadConfig(variant: string): Promise<ExportedConfig> {
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("APPLE_TEAM_ID", "TEAM123456");
  vi.stubEnv("NODEX_MOBILE_VERSION", "2.3.4");
  vi.stubEnv("NODEX_MOBILE_IOS_BUILD", "42");
  vi.resetModules();
  const { default: exp } = await import("../../app.config");
  return withPlugins(
    { ...exp, _internal: { projectRoot: mobile } },
    exp.plugins.filter((entry) => {
      const plugin = Array.isArray(entry) ? entry[0] : entry;
      return (
        plugin === "./plugins/withShareTargets.cjs" ||
        plugin === "./plugins/withNotificationDecryption.cjs"
      );
    }),
  );
}

async function runMod<T>(
  config: ExportedConfig,
  projectRoot: string,
  platform: "ios" | "android",
  name: string,
  results: T,
): Promise<T> {
  const mods: Record<string, Mod | undefined> | undefined = config.mods?.[platform];
  const mod = mods?.[name] as Mod<T> | undefined;
  if (!mod) return results;
  const { modResults } = await mod({
    ...config,
    modRequest: {
      projectRoot,
      platformProjectRoot: path.join(projectRoot, platform),
      platform,
      modName: name,
      introspect: false,
    },
    modRawConfig: config,
    modResults: results,
  });
  return modResults;
}

it.each([
  ["development", "app.jyu.nodex.mobile.dev", "Nodex Dev", ["nodex-mobile-dev", "nodex-mobile"]],
  ["production", "app.jyu.nodex.mobile", "Nodex", ["nodex-mobile"]],
] as const)(
  "embeds both Inbox share targets for %s alongside notifications",
  async (variant, bundleId, name, schemes) => {
    const directory = await mkdtemp(path.join(tmpdir(), "nodex-share-targets-"));
    try {
      const ios = path.join(directory, "ios");
      const xcodeDirectory = path.join(ios, "Nodex.xcodeproj");
      await mkdir(xcodeDirectory, { recursive: true });
      const projectPath = path.join(xcodeDirectory, "project.pbxproj");
      await writeFile(projectPath, projectFixture);
      const config = IOSConfig.DevelopmentTeam.withDevelopmentTeam(await loadConfig(variant));
      const appGroup = `group.${bundleId}`;
      expect(config.scheme).toEqual(schemes);

      let project = IOSConfig.XcodeUtils.getPbxproj(directory);
      Object.assign(project.hash.project.objects, { PBXBuildFile: {}, PBXFileReference: {} });
      for (let iteration = 0; iteration < 2; iteration++) {
        await runMod(config, directory, "ios", "dangerous", null);
        await runMod(config, directory, "ios", "xcodeproj", project);
        await writeFile(projectPath, project.writeSync());
        project = IOSConfig.XcodeUtils.getPbxproj(directory);
      }

      const targets = IOSConfig.Target.getNativeTargets(project);
      expect(targets.map(([, target]) => unquote(target.name)).sort()).toEqual([
        "Nodex",
        "NodexAction",
        "NotificationService",
        "expo-sharing-extension",
      ]);
      const objects = project.hash.project.objects;
      const main = project.getTarget("com.apple.product-type.application");
      const embedded = main.target.buildPhases.flatMap(({ value }: { value: string }) => {
        const phase = objects.PBXCopyFilesBuildPhase[value];
        if (String(phase?.dstSubfolderSpec) !== "13") return [];
        return phase.files.map(({ value: file }: { value: string }) => {
          const ref = objects.PBXBuildFile[file].fileRef;
          return unquote(objects.PBXFileReference[ref].path);
        });
      });
      expect(embedded.sort()).toEqual([
        "NodexAction.appex",
        "NotificationService.appex",
        "expo-sharing-extension.appex",
      ]);

      for (const [targetName, displayName, extensionPoint] of [
        ["expo-sharing-extension", name, "com.apple.share-services"],
        ["NodexAction", "Add to Nodex Inbox", "com.apple.ui-services"],
      ] as const) {
        const [, target] = targets.find(([, item]) => unquote(item.name) === targetName)!;
        const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
          project,
          target.buildConfigurationList,
        );
        expect(configurations).toHaveLength(2);
        for (const [, { buildSettings }] of configurations) {
          expect(buildSettings).toMatchObject({
            PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.${targetName}"`,
            DEVELOPMENT_TEAM: "TEAM123456",
            CODE_SIGN_STYLE: "Automatic",
            MARKETING_VERSION: "2.3.4",
            IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          });
          expect(String(buildSettings.CURRENT_PROJECT_VERSION)).toBe("42");
          expect(unquote(buildSettings.CODE_SIGN_ENTITLEMENTS ?? "")).toBe(
            `${targetName}/${targetName}.entitlements`,
          );
        }
        const readPlist = async (file: string) =>
          plist.parse(await readFile(path.join(ios, targetName, file), "utf8"));
        expect(await readPlist(`${targetName}.entitlements`)).toEqual({ [groupKey]: [appGroup] });
        const info = (await readPlist("Info.plist")) as {
          NSExtension: { NSExtensionAttributes: { NSExtensionActivationRule: unknown } };
        };
        expect(info).toMatchObject({
          CFBundleDisplayName: displayName,
          CFBundleShortVersionString: "$(MARKETING_VERSION)",
          CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
          AppGroupId: appGroup,
          MainTargetUrlScheme: schemes[0],
          NSExtension: {
            NSExtensionPointIdentifier: extensionPoint,
            NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).ShareIntoViewController",
          },
        });
        expect(info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule).toEqual({
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
          NSExtensionActivationSupportsImageWithMaxCount: 6,
        });
      }

      expect(await runMod(config, directory, "ios", "entitlements", {})).toEqual({
        [groupKey]: [appGroup],
        "keychain-access-groups": [`$(AppIdentifierPrefix)${bundleId}.push`],
      });
      expect(await runMod(config, directory, "ios", "infoPlist", {})).toMatchObject({
        ExpoShareIntoAppGroupId: appGroup,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("registers exactly three Android share filters across repeated generation", async () => {
  const config = await loadConfig("development");
  const launcher = { action: [{ $: { "android:name": "android.intent.action.MAIN" } }] };
  let manifest: AndroidConfig.Manifest.AndroidManifest = {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      queries: [],
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [{ $: { "android:name": ".MainActivity" }, "intent-filter": [launcher] }],
        },
      ],
    },
  };
  for (let iteration = 0; iteration < 2; iteration++) {
    manifest = await runMod(config, mobile, "android", "manifest", manifest);
  }
  const [main, ...shares] =
    AndroidConfig.Manifest.getMainActivityOrThrow(manifest)["intent-filter"]!;
  expect(main).toEqual(launcher);
  expect(
    shares.map((filter) => ({
      action: filter.action,
      category: filter.category,
      data: filter.data,
    })),
  ).toEqual(
    [
      ["SEND", "text/plain"],
      ["SEND", "image/*"],
      ["SEND_MULTIPLE", "image/*"],
    ].map(([action, mimeType]) => ({
      action: [{ $: { "android:name": `android.intent.action.${action}` } }],
      category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
      data: [{ $: { "android:mimeType": mimeType } }],
    })),
  );
  expect(await runMod(config, mobile, "android", "strings", { resources: {} })).toMatchObject({
    resources: {
      string: [{ $: { name: "share_into_scheme", translatable: "false" }, _: "nodex-mobile-dev" }],
    },
  });
});

it("keeps share targets out of the TLS proof app", async () => {
  const config = await loadConfig("tls-proof");
  expect(config.scheme).toEqual(["nodex-mobile-tls-proof"]);
  expect(config.ios?.entitlements?.[groupKey]).toBeUndefined();
  expect(config.mods?.ios?.infoPlist).toBeUndefined();
  expect(config.mods?.android?.manifest).toBeUndefined();
  expect(config.mods?.android?.strings).toBeUndefined();
  expect(config.extra?.eas?.build?.experimental?.ios?.appExtensions).toBeUndefined();
});
