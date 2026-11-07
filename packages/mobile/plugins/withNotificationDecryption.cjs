const { copyFile, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  IOSConfig,
  withDangerousMod,
  withEntitlementsPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const targetName = "NotificationService";
const sources = ["NotificationService.swift", "PushDecryption.swift"];
const unquote = (value) => String(value).replace(/^"|"$/g, "");

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Nodex</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NodexPushKeychainGroup</key><string>$(NODEX_PUSH_KEYCHAIN_GROUP)</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict></plist>
`;

function buildConfigurations(project, target) {
  return IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
    project,
    target.buildConfigurationList,
  );
}

/** Recreates the service and its shared keychain access whenever Expo regenerates iOS. */
module.exports = function withNotificationDecryption(config) {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) throw new Error("Notification decryption requires an iOS bundle identifier.");
  const group = `$(AppIdentifierPrefix)${bundleId}.push`;

  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["keychain-access-groups"] = [
      ...new Set([...(cfg.modResults["keychain-access-groups"] ?? []), group]),
    ];
    return cfg;
  });

  config = withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const directory = path.join(cfg.modRequest.platformProjectRoot, targetName);
      await mkdir(directory, { recursive: true });
      for (const source of sources) {
        await copyFile(
          path.join(__dirname, "../notification-service", source),
          path.join(directory, source),
        );
      }
      await writeFile(path.join(directory, "Info.plist"), infoPlist);
      await writeFile(
        path.join(directory, `${targetName}.entitlements`),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>keychain-access-groups</key><array><string>${group}</string></array>
</dict></plist>
`,
      );
      return cfg;
    },
  ]);

  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const objects = project.hash.project.objects;
    const main = project.getTarget("com.apple.product-type.application");
    if (!main) throw new Error("Notification decryption requires an iOS application target.");

    // Find this extension by name when other app extensions are installed too.
    const existing = Object.entries(objects.PBXNativeTarget).find(
      ([id, target]) => !id.endsWith("_comment") && unquote(target.name) === targetName,
    );
    let extension = existing ? { uuid: existing[0], pbxNativeTarget: existing[1] } : null;
    if (!extension) {
      extension = project.addTarget(
        targetName,
        "app_extension",
        targetName,
        `${bundleId}.${targetName}`,
      );
      project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", extension.uuid);
      project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", extension.uuid);
      const group = project.addPbxGroup([], targetName, targetName);
      project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
      for (const source of sources)
        project.addSourceFile(source, { target: extension.uuid }, group.uuid);
      project.addFile("Info.plist", group.uuid);
      project.addFile(`${targetName}.entitlements`, group.uuid);
    }

    const mainConfigurations = buildConfigurations(project, main.target);
    const projectConfigurations = buildConfigurations(
      project,
      project.getFirstProject().firstProject,
    );
    for (const [, configuration] of buildConfigurations(project, extension.pbxNativeTarget)) {
      const mainSettings = mainConfigurations.find(
        ([, item]) => item.name === configuration.name,
      )?.[1].buildSettings;
      const projectSettings = projectConfigurations.find(
        ([, item]) => item.name === configuration.name,
      )?.[1].buildSettings;
      const deploymentTarget =
        mainSettings?.IPHONEOS_DEPLOYMENT_TARGET ?? projectSettings?.IPHONEOS_DEPLOYMENT_TARGET;
      if (!deploymentTarget)
        throw new Error("Missing iOS deployment target for notification decryption.");
      Object.assign(configuration.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: "YES",
        CODE_SIGN_ENTITLEMENTS: `${targetName}/${targetName}.entitlements`,
        CODE_SIGN_STYLE: "Automatic",
        // Expo writes the app's versions to Info.plist; template build settings can be stale.
        CURRENT_PROJECT_VERSION: IOSConfig.Version.getBuildNumber(cfg),
        INFOPLIST_FILE: `${targetName}/Info.plist`,
        IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
        MARKETING_VERSION: IOSConfig.Version.getVersion(cfg),
        NODEX_PUSH_KEYCHAIN_GROUP: `"${group}"`,
        PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.${targetName}"`,
        SWIFT_VERSION: mainSettings?.SWIFT_VERSION ?? "5.0",
        TARGETED_DEVICE_FAMILY: mainSettings?.TARGETED_DEVICE_FAMILY ?? '"1,2"',
      });
      // Expo's signing mod may run before this target exists. Never rely on it to sign the extension.
      const team = cfg.ios?.appleTeamId ?? mainSettings?.DEVELOPMENT_TEAM;
      if (team) configuration.buildSettings.DEVELOPMENT_TEAM = team;
      else delete configuration.buildSettings.DEVELOPMENT_TEAM;
    }
    return cfg;
  });
};
