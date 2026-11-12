const { readdirSync } = require("node:fs");
const { copyFile, mkdir, readFile, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const {
  AndroidConfig,
  IOSConfig,
  withAndroidManifest,
  withDangerousMod,
  withXcodeProject,
} = require("expo/config-plugins");

const withExpoSharing = require("expo-sharing/app.plugin").default;
const sharingPackage = require.resolve("expo-sharing/package.json");
const plist = createRequire(sharingPackage)("@expo/plist").default;

const shareTarget = "expo-sharing-extension";
const actionTarget = "NodexAction";
const actionIcon = "NodexActionIcon";
const iconFiles = [`${actionIcon}.png`, `${actionIcon}@2x.png`, `${actionIcon}@3x.png`];
const appGroupsKey = "com.apple.security.application-groups";
const unquote = (value) => String(value).replace(/^"|"$/g, "");
const buildConfigurations = (project, target) =>
  IOSConfig.XcodeUtils.getBuildConfigurationsForListId(project, target.buildConfigurationList);

function withExtensionFiles(config, appGroupId, sources) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const ios = cfg.modRequest.platformProjectRoot;
      const shareInfo = path.join(ios, shareTarget, "Info.plist");
      const info = plist.parse(await readFile(shareInfo, "utf8"));
      info.CFBundleDisplayName = cfg.name;
      await writeFile(shareInfo, plist.build(info));

      const directory = path.join(ios, actionTarget);
      await mkdir(directory, { recursive: true });
      await Promise.all([
        ...sources.map((source) => copyFile(source, path.join(directory, path.basename(source)))),
        ...iconFiles.map((icon) =>
          copyFile(path.join(__dirname, "../assets", icon), path.join(directory, icon)),
        ),
        writeFile(
          path.join(directory, "Info.plist"),
          plist.build({
            ...info,
            CFBundleDisplayName: "Add to Nodex Inbox",
            CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: [actionIcon] } },
            NSExtension: {
              ...info.NSExtension,
              NSExtensionPointIdentifier: "com.apple.ui-services",
            },
          }),
        ),
        writeFile(
          path.join(directory, `${actionTarget}.entitlements`),
          plist.build({ [appGroupsKey]: [appGroupId] }),
        ),
      ]);
      return cfg;
    },
  ]);
}

function addActionTarget(project, bundleId, sources) {
  const extension = project.addTarget(
    actionTarget,
    "app_extension",
    actionTarget,
    `${bundleId}.${actionTarget}`,
  );
  const filePath = (name) => `${actionTarget}/${name}`;
  const swift = sources.map((source) => filePath(path.basename(source)));
  const icons = iconFiles.map(filePath);
  project.addBuildPhase(swift, "PBXSourcesBuildPhase", "Sources", extension.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", extension.uuid);
  project.addBuildPhase(icons, "PBXResourcesBuildPhase", "Resources", extension.uuid);
  const group = project.addPbxGroup(
    [...swift, ...icons, filePath("Info.plist"), filePath(`${actionTarget}.entitlements`)],
    actionTarget,
    ".",
  );
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  return [extension.uuid, extension.pbxNativeTarget];
}

function withExtensionTargets(config, bundleId, sources) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const main = project.getTarget("com.apple.product-type.application");
    if (!main) throw new Error("Inbox sharing requires an iOS application target.");

    const targets = IOSConfig.Target.getNativeTargets(project);
    const share = targets.find(([, target]) => unquote(target.name) === shareTarget);
    if (!share) throw new Error("Missing iOS share target.");

    const objects = project.hash.project.objects;
    objects.PBXContainerItemProxy ??= {};
    objects.PBXTargetDependency ??= {};
    const action =
      targets.find(([, target]) => unquote(target.name) === actionTarget) ??
      addActionTarget(project, bundleId, sources);
    const appSettings = buildConfigurations(project, main.target);
    const projectSettings = buildConfigurations(project, project.getFirstProject().firstProject);
    for (const [id, target] of [share, action]) {
      if (
        !main.target.dependencies.some(
          ({ value }) => objects.PBXTargetDependency[value]?.target === id,
        )
      )
        project.addTargetDependency(main.uuid, [id]);
      const targetName = unquote(target.name);
      for (const [, { name, buildSettings }] of buildConfigurations(project, target)) {
        const app = appSettings.find(([, item]) => item.name === name)?.[1].buildSettings;
        const inherited = projectSettings.find(([, item]) => item.name === name)?.[1].buildSettings;
        const deploymentTarget =
          app?.IPHONEOS_DEPLOYMENT_TARGET ?? inherited?.IPHONEOS_DEPLOYMENT_TARGET;
        if (!deploymentTarget) throw new Error("Missing iOS deployment target for Inbox sharing.");
        Object.assign(buildSettings, {
          APPLICATION_EXTENSION_API_ONLY: "YES",
          CURRENT_PROJECT_VERSION: IOSConfig.Version.getBuildNumber(cfg),
          IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
          MARKETING_VERSION: IOSConfig.Version.getVersion(cfg),
          TARGETED_DEVICE_FAMILY: app?.TARGETED_DEVICE_FAMILY ?? '"1,2"',
        });
        const team = cfg.ios?.appleTeamId ?? app?.DEVELOPMENT_TEAM;
        if (team) buildSettings.DEVELOPMENT_TEAM = team;
        else delete buildSettings.DEVELOPMENT_TEAM;
        delete buildSettings.INFOPLIST_KEY_CFBundleDisplayName;
        if (targetName === actionTarget) {
          Object.assign(buildSettings, {
            CODE_SIGN_ENTITLEMENTS: `${actionTarget}/${actionTarget}.entitlements`,
            CODE_SIGN_STYLE: "Automatic",
            INFOPLIST_FILE: `${actionTarget}/Info.plist`,
            SWIFT_VERSION: "5.0",
          });
        }
      }
    }
    return cfg;
  });
}

module.exports = function withShareTargets(config, { enabled }) {
  if (!enabled) return config;

  const { scheme } = config;
  const shareScheme = Array.isArray(scheme) ? scheme[0] : scheme;
  const bundleId = config.ios?.bundleIdentifier;
  if (!shareScheme || !bundleId) throw new Error("Inbox sharing requires a scheme and bundle ID.");

  const appGroupId = `group.${bundleId}`;
  const packageRoot = path.dirname(sharingPackage);
  const sharedDirectory = path.join(packageRoot, "ios/shared");
  const sources = [
    path.join(packageRoot, "plugin/template-files/ios/ShareIntoViewController.swift"),
    ...readdirSync(sharedDirectory)
      .filter((file) => file.endsWith(".swift"))
      .map((file) => path.join(sharedDirectory, file)),
  ];

  // Mods run in reverse registration order. Refine the generated files, targets and filters.
  config = withExtensionFiles(config, appGroupId, sources);
  config = withExtensionTargets(config, bundleId, sources);
  config = withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    // Keep Expo's marker so it replaces all generated filters on the next prebuild.
    activity["intent-filter"] = activity["intent-filter"].flatMap((filter) =>
      filter.$?.["expo-sharing-intent-filters"] === "true"
        ? filter.data.map((data) => ({ ...filter, data: [data] }))
        : [filter],
    );
    return cfg;
  });

  const sharing = withExpoSharing(
    { ...config, scheme: shareScheme },
    {
      ios: {
        enabled: true,
        appGroupId,
        extensionBundleIdentifier: `${bundleId}.${shareTarget}`,
        activationRule: {
          supportsText: true,
          supportsWebUrlWithMaxCount: 1,
          supportsWebPageWithMaxCount: 1,
          supportsImageWithMaxCount: 6,
        },
      },
      android: {
        enabled: true,
        singleShareMimeTypes: ["text/plain", "image/*"],
        multipleShareMimeTypes: ["image/*"],
      },
    },
  );
  return { ...sharing, scheme };
};
