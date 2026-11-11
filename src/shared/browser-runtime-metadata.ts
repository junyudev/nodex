import { BROWSER_RUNTIME_SCHEMA_VERSION as schemaVersion } from "./browser-runtime-schema.mjs";

export const BROWSER_RUNTIME_BUNDLE_DIRECTORY = "browser-runtime";
export const BROWSER_RUNTIME_MANIFEST_FILENAME = "browser-runtime-manifest.json";
export const BROWSER_RUNTIME_SCHEMA_VERSION = schemaVersion;
export const BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION = "15.0";
export const BROWSER_PLUGIN_NODE_MODULE_DIR = "marketplace/plugins/browser/node_modules";

export type BrowserRuntimeArtifactArchitecture = "any" | "arm64" | "universal" | "x64";
export type BrowserRuntimeArtifactKind = "data" | "executable" | "native-addon" | "library";
export type BrowserRuntimeBackend = "chrome" | "iab";

export type BrowserRuntimeBundledPlugin = {
  docs: string;
  id: "computer-use@openai-bundled";
  manifest: string;
  marketplaceManifest: string;
  marketplaceRoot: string;
  nodeModuleDirs: string[];
  root: string;
  version: string;
};

export type BrowserRuntimeComputerUseCapability =
  | {
      reason: "architecture-unsupported";
      status: "unavailable";
    }
  | {
      appBundle: string;
      appBundleIdentifier: string;
      artifactMinimumMacOSVersion: "14.4";
      ipcProtocol: "CodexComputerUseIPC-5";
      plugin: BrowserRuntimeBundledPlugin;
      productMinimumMacOSVersion: typeof BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION;
      rpcService: string;
      serviceExecutable: string;
      status: "available";
    };

export const BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS = {
  computerUseService: [
    "computerUseServiceProcessMatchesExecutablePath",
    "connectRemoteHostedPIPContentHost",
    "spawnComputerUseService",
  ],
  hostLayout: [
    "getRemoteHostedPIPContentLayoutState",
    "registerRemoteHostedPIPContentHost",
    "setRemoteHostedPIPContentLayoutStateChangedHandler",
    "setRemoteHostedPIPContentMaxDisplaySize",
    "setRemoteHostedPIPContentMaxDisplaySizeChangedHandler",
    "startRemoteHostedPIPContentHost",
    "stopRemoteHostedPIPContentHost",
    "unregisterRemoteHostedPIPContentHost",
  ],
  interaction: [
    "isPrivacySettingsTerminationRequest",
    "setBrowserUsePIPContentClickHandler",
    "setRemoteHostedPIPContentComputerUseCursorLocationHandler",
    "setRemoteHostedPIPContentPetWakeRequestHandler",
    "setRemoteHostedPIPContentShouldShowTaskHandler",
    "setRemoteHostedPIPContentVisibilityRequestHandler",
  ],
  presentation: [
    "completeRemoteHostedPIPContentThread",
    "getRemoteHostedPIPContentActiveTaskIDs",
    "hasRemoteHostedPIPContentAnyPresentation",
    "invalidateBrowserUsePIPContent",
    "invalidateRemoteHostedPIPContentTurn",
    "refreshRemoteHostedPIPContentVisibility",
    "setRemoteHostedPIPContentActiveThreadID",
    "setRemoteHostedPIPContentSuppressedThreadIDs",
    "upsertBrowserUsePIPContent",
  ],
} as const;

export const BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS = [
  "completeRemoteHostedPIPContentThread",
  "computerUseServiceProcessMatchesExecutablePath",
  "connectRemoteHostedPIPContentHost",
  "createStatusItem",
  "destroyStatusItem",
  "finishWindowDrag",
  "frontmostWindow",
  "getRemoteHostedPIPContentActiveTaskIDs",
  "getRemoteHostedPIPContentLayoutState",
  "hasRemoteHostedPIPContentAnyPresentation",
  "iconMediumForAppPath",
  "iconSmallForAppPath",
  "invalidateBrowserUsePIPContent",
  "invalidateRemoteHostedPIPContentTurn",
  "isPrivacySettingsTerminationRequest",
  "isWindowDragActive",
  "performWindowDrag",
  "refreshRemoteHostedPIPContentVisibility",
  "registerRemoteHostedPIPContentHost",
  "setBrowserUsePIPContentClickHandler",
  "setRemoteHostedPIPContentActiveThreadID",
  "setRemoteHostedPIPContentComputerUseCursorLocationHandler",
  "setRemoteHostedPIPContentLayoutStateChangedHandler",
  "setRemoteHostedPIPContentMaxDisplaySize",
  "setRemoteHostedPIPContentMaxDisplaySizeChangedHandler",
  "setRemoteHostedPIPContentPetWakeRequestHandler",
  "setRemoteHostedPIPContentShouldShowTaskHandler",
  "setRemoteHostedPIPContentSuppressedThreadIDs",
  "setRemoteHostedPIPContentVisibilityRequestHandler",
  "setWindowDragTarget",
  "spawnComputerUseService",
  "startFileDrag",
  "startRemoteHostedPIPContentHost",
  "stopRemoteHostedPIPContentHost",
  "unregisterRemoteHostedPIPContentHost",
  "updateStatusItemMenuState",
  "updateStatusItemState",
  "upsertBrowserUsePIPContent",
] as const;

export type BrowserRuntimeNativePipCapability = {
  addon: string;
  artifactMinimumMacOSVersion: "13.0";
  controlAssets: string[];
  exports: {
    expectedExportCount: number;
    expectedExports: string[];
    groups: typeof BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS;
  };
  productMinimumMacOSVersion: typeof BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION;
  status: "available";
};

export type BrowserRuntimeChromeCapability<
  HostTrust = {
    artifactMinimumMacOSVersion: string;
    productMinimumMacOSVersion: typeof BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION;
  },
> =
  | { reason: "not-bundled"; status: "unavailable" }
  | {
      extensionIds: string[];
      familyDescriptor: string;
      installManifest: string;
      nativeHost: HostTrust & {
        hostName: "com.openai.codexextension";
        path: string;
      };
      plugin: {
        id: "chrome@openai-bundled";
        manifest: string;
        root: string;
        version: string;
      };
      status: "available";
    };

export type BrowserRuntimeBrowserUseCapability<Chrome = BrowserRuntimeChromeCapability> = {
  backends: {
    chrome: Chrome;
    iab: { status: "available" };
  };
};

export type BrowserRuntimeArtifact = {
  architecture: BrowserRuntimeArtifactArchitecture;
  executable: boolean;
  kind: BrowserRuntimeArtifactKind;
  path: string;
  sha256: string;
  size: number;
};

type BrowserRuntimeManifestCommon = {
  artifacts: BrowserRuntimeArtifact[];
  browserPlugin: {
    client: string;
    docs: string;
    id: "browser@openai-bundled";
    manifest: string;
    marketplaceManifest: string;
    marketplaceRoot: string;
    nodeModuleDirs: string[];
    root: string;
    service: string;
    version: string;
  };
  buildFlavor: string;
  codexCompatibilityVersion: string;
  desktopBuild: string;
  desktopBuildNumber: string;
  schemaVersion: typeof BROWSER_RUNTIME_SCHEMA_VERSION;
  supportedBackends: BrowserRuntimeBackend[];
};

type BrowserRuntimeEntrypoints = { codexCli: string; node: string; nodeRepl: string };
type BrowserRuntimeVersions = { codexCli: string; cuaRuntime: string; node: string };

export type MacBrowserRuntimeManifest = BrowserRuntimeManifestCommon & {
  capabilities: {
    browserUse: BrowserRuntimeBrowserUseCapability;
    computerUse: BrowserRuntimeComputerUseCapability;
    nativePip: BrowserRuntimeNativePipCapability;
  };
  entrypoints: BrowserRuntimeEntrypoints & { peerAuthorization: string };
  runtimeVersions: BrowserRuntimeVersions & { peerAuthorization: string };
  targetArch: "arm64";
  targetPlatform: "darwin";
  trust: {
    signingTeamId: string;
    nodeApiVersion: string;
    computerUseSigningTeamId?: string;
    chromeSigningTeamId?: string;
  };
};

export type WindowsBrowserRuntimeArch = "x64" | "arm64";
export type WindowsAuthenticodePublisherPolicy = {
  subject: string;
  issuer: string;
};
export type WindowsBrowserRuntimePe = {
  machine: WindowsBrowserRuntimeArch;
  publisher: WindowsAuthenticodePublisherPolicy;
};
export type WindowsBrowserRuntimePackageIdentity = {
  name: string;
  publisher: string;
  version: string;
};
export type WindowsBrowserRuntimeManifest = BrowserRuntimeManifestCommon & {
  capabilities: {
    browserUse: BrowserRuntimeBrowserUseCapability<BrowserRuntimeChromeCapability<unknown>>;
    computerUse: {
      plugin: BrowserRuntimeBundledPlugin;
      serviceExecutable: string;
      captureExecutable: string;
      minimumWindowsVersion?: string;
      status: "available";
    };
    nativePip?: never;
  };
  entrypoints: BrowserRuntimeEntrypoints & { processEnumeration: string };
  runtimeVersions: BrowserRuntimeVersions;
  sourcePackage: WindowsBrowserRuntimePackageIdentity;
  targetArch: WindowsBrowserRuntimeArch;
  targetPlatform: "win32";
  trust: { pe: Record<string, WindowsBrowserRuntimePe> };
};

export type BrowserRuntimeManifest = MacBrowserRuntimeManifest | WindowsBrowserRuntimeManifest;
export type BrowserRuntimeTargetKey = "darwin-arm64" | "win32-x64" | "win32-arm64";

export function browserRuntimeTargetKey(
  platform: string,
  arch: string,
): BrowserRuntimeTargetKey | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `win32-${arch}`;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeBrowserRuntimeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isSafeWindowsBrowserRuntimePath(value: string): boolean {
  return (
    isSafeBrowserRuntimeRelativePath(value) &&
    value
      .split("/")
      .every(
        (segment) =>
          !/[<>:"|?*\x00-\x1f]/u.test(segment) &&
          !/[. ]$/u.test(segment) &&
          !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment),
      )
  );
}

function parseNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    ? value
    : null;
}

function parseArtifact(value: unknown): BrowserRuntimeArtifact | null {
  if (!isObject(value)) return null;
  if (typeof value.path !== "string" || !isSafeBrowserRuntimeRelativePath(value.path)) return null;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) return null;
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)
    return null;
  if (typeof value.executable !== "boolean") return null;
  if (!["any", "arm64", "universal", "x64"].includes(String(value.architecture))) return null;
  if (!["data", "executable", "native-addon", "library"].includes(String(value.kind))) return null;

  const kind = value.kind as BrowserRuntimeArtifactKind;
  if ((kind === "executable") !== value.executable) return null;
  if (kind === "data" && value.architecture !== "any") return null;
  if (kind === "native-addon" && value.architecture === "any") return null;

  return {
    architecture: value.architecture as BrowserRuntimeArtifactArchitecture,
    executable: value.executable,
    kind,
    path: value.path,
    sha256: value.sha256,
    size: value.size,
  };
}

function parseEntrypoints(value: unknown): BrowserRuntimeEntrypoints | null {
  if (!isObject(value)) return null;
  const codexCli = parseNonEmptyString(value.codexCli);
  const node = parseNonEmptyString(value.node);
  const nodeRepl = parseNonEmptyString(value.nodeRepl);
  if (!codexCli || !node || !nodeRepl) return null;
  if (![codexCli, node, nodeRepl].every(isSafeBrowserRuntimeRelativePath)) return null;
  if (new Set([codexCli, node, nodeRepl]).size !== 3) return null;
  return { codexCli, node, nodeRepl };
}

function parseBrowserPlugin(value: unknown): BrowserRuntimeManifest["browserPlugin"] | null {
  if (!isObject(value) || value.id !== "browser@openai-bundled") return null;
  const version = parseNonEmptyString(value.version);
  const root = parseNonEmptyString(value.root);
  const manifest = parseNonEmptyString(value.manifest);
  const client = parseNonEmptyString(value.client);
  const service = parseNonEmptyString(value.service);
  const docs = parseNonEmptyString(value.docs);
  const marketplaceRoot = parseNonEmptyString(value.marketplaceRoot);
  const marketplaceManifest = parseNonEmptyString(value.marketplaceManifest);
  if (
    !version ||
    !root ||
    !manifest ||
    !client ||
    !service ||
    !docs ||
    !marketplaceRoot ||
    !marketplaceManifest
  )
    return null;
  const pluginPaths = [root, manifest, client, service, docs, marketplaceRoot, marketplaceManifest];
  if (!pluginPaths.every(isSafeBrowserRuntimeRelativePath)) return null;
  const rootPrefix = `${root}/`;
  if (![manifest, client, service, docs].every((entry) => entry.startsWith(rootPrefix))) {
    return null;
  }
  const marketplaceRootPrefix = `${marketplaceRoot}/`;
  if (
    !root.startsWith(marketplaceRootPrefix) ||
    !marketplaceManifest.startsWith(marketplaceRootPrefix)
  )
    return null;
  if (!Array.isArray(value.nodeModuleDirs)) return null;
  const nodeModuleDirs = value.nodeModuleDirs.map(parseNonEmptyString);
  if (nodeModuleDirs.some((entry) => entry === null)) return null;
  const parsedNodeModuleDirs = nodeModuleDirs as string[];
  if (
    parsedNodeModuleDirs.length === 0 ||
    new Set(parsedNodeModuleDirs).size !== parsedNodeModuleDirs.length ||
    !parsedNodeModuleDirs.every(isSafeBrowserRuntimeRelativePath)
  ) {
    return null;
  }
  return {
    client,
    docs,
    id: value.id,
    manifest,
    marketplaceManifest,
    marketplaceRoot,
    nodeModuleDirs: parsedNodeModuleDirs,
    root,
    service,
    version,
  };
}

function parseComputerUsePlugin(value: unknown): BrowserRuntimeBundledPlugin | null {
  if (!isObject(value) || value.id !== "computer-use@openai-bundled") return null;
  const version = parseNonEmptyString(value.version);
  const root = parseNonEmptyString(value.root);
  const manifest = parseNonEmptyString(value.manifest);
  const docs = parseNonEmptyString(value.docs);
  const marketplaceRoot = parseNonEmptyString(value.marketplaceRoot);
  const marketplaceManifest = parseNonEmptyString(value.marketplaceManifest);
  if (!version || !root || !manifest || !docs || !marketplaceRoot || !marketplaceManifest) {
    return null;
  }
  const pluginPaths = [root, manifest, docs, marketplaceRoot, marketplaceManifest];
  if (!pluginPaths.every(isSafeBrowserRuntimeRelativePath)) return null;
  const rootPrefix = `${root}/`;
  if (![manifest, docs].every((entry) => entry.startsWith(rootPrefix))) return null;
  const marketplaceRootPrefix = `${marketplaceRoot}/`;
  if (!root.startsWith(marketplaceRootPrefix)) return null;
  if (!marketplaceManifest.startsWith(marketplaceRootPrefix)) return null;
  if (!Array.isArray(value.nodeModuleDirs)) return null;
  const nodeModuleDirs = value.nodeModuleDirs.map(parseNonEmptyString);
  if (nodeModuleDirs.some((entry) => entry === null)) return null;
  const parsedNodeModuleDirs = nodeModuleDirs as string[];
  if (
    parsedNodeModuleDirs.length === 0 ||
    new Set(parsedNodeModuleDirs).size !== parsedNodeModuleDirs.length ||
    !parsedNodeModuleDirs.every(isSafeBrowserRuntimeRelativePath)
  ) {
    return null;
  }
  return {
    docs,
    id: value.id,
    manifest,
    marketplaceManifest,
    marketplaceRoot,
    nodeModuleDirs: parsedNodeModuleDirs,
    root,
    version,
  };
}

function hasExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function parseNativePipCapability(value: unknown): BrowserRuntimeNativePipCapability | null {
  if (
    !isObject(value) ||
    value.status !== "available" ||
    value.artifactMinimumMacOSVersion !== "13.0" ||
    value.productMinimumMacOSVersion !== BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION
  )
    return null;
  const addon = parseNonEmptyString(value.addon);
  if (!addon || !isSafeBrowserRuntimeRelativePath(addon)) return null;
  if (!Array.isArray(value.controlAssets) || value.controlAssets.length !== 2) return null;
  const controlAssets = value.controlAssets.map(parseNonEmptyString);
  if (controlAssets.some((entry) => entry === null)) return null;
  const parsedControlAssets = controlAssets as string[];
  if (
    new Set(parsedControlAssets).size !== parsedControlAssets.length ||
    !parsedControlAssets.every(isSafeBrowserRuntimeRelativePath)
  ) {
    return null;
  }
  if (!isObject(value.exports) || !Array.isArray(value.exports.expectedExports)) return null;
  const expectedExports = value.exports.expectedExports.map((entry) =>
    typeof entry === "string" ? entry : "",
  );
  if (
    expectedExports.length === 0 ||
    value.exports.expectedExportCount !== expectedExports.length ||
    new Set(expectedExports).size !== expectedExports.length ||
    !expectedExports.every((entry) => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(entry)) ||
    expectedExports.some((entry, index) => index > 0 && entry <= expectedExports[index - 1]!)
  ) {
    return null;
  }
  if (!isObject(value.exports.groups)) return null;
  for (const [group, expected] of Object.entries(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS)) {
    if (!hasExactStringArray(value.exports.groups[group], expected)) return null;
    if (!expected.every((exportName) => expectedExports.includes(exportName))) return null;
  }
  return {
    addon,
    artifactMinimumMacOSVersion: "13.0",
    controlAssets: parsedControlAssets,
    exports: {
      expectedExportCount: expectedExports.length,
      expectedExports,
      groups: BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
    },
    productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
    status: "available",
  };
}

function parseComputerUseCapability(value: unknown): BrowserRuntimeComputerUseCapability | null {
  if (!isObject(value)) return null;
  if (value.status === "unavailable") {
    return value.reason === "architecture-unsupported"
      ? { reason: value.reason, status: value.status }
      : null;
  }
  if (
    value.status !== "available" ||
    value.artifactMinimumMacOSVersion !== "14.4" ||
    value.productMinimumMacOSVersion !== BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION ||
    value.ipcProtocol !== "CodexComputerUseIPC-5"
  )
    return null;
  const appBundle = parseNonEmptyString(value.appBundle);
  const appBundleIdentifier = parseNonEmptyString(value.appBundleIdentifier);
  const rpcService = parseNonEmptyString(value.rpcService);
  const serviceExecutable = parseNonEmptyString(value.serviceExecutable);
  const plugin = parseComputerUsePlugin(value.plugin);
  if (!appBundle || !appBundleIdentifier || !rpcService || !serviceExecutable || !plugin) {
    return null;
  }
  if (![appBundle, rpcService, serviceExecutable].every(isSafeBrowserRuntimeRelativePath)) {
    return null;
  }
  if (!serviceExecutable.startsWith(`${appBundle}/`)) return null;
  if (!rpcService.startsWith(`${plugin.nodeModuleDirs[0]}/`)) return null;
  return {
    appBundle,
    appBundleIdentifier,
    artifactMinimumMacOSVersion: "14.4",
    ipcProtocol: "CodexComputerUseIPC-5",
    plugin,
    productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
    rpcService,
    serviceExecutable,
    status: value.status,
  };
}

function parseBrowserUseCapability<HostTrust>(
  value: unknown,
  parseHostTrust: (value: Record<string, unknown>) => HostTrust | null,
): BrowserRuntimeBrowserUseCapability<BrowserRuntimeChromeCapability<HostTrust>> | null {
  if (!isObject(value) || !isObject(value.backends)) return null;
  if (!isObject(value.backends.iab) || value.backends.iab.status !== "available") return null;
  const chrome = value.backends.chrome;
  if (!isObject(chrome)) return null;
  if (chrome.status === "unavailable") {
    if (chrome.reason !== "not-bundled") return null;
    return {
      backends: {
        chrome: { reason: "not-bundled", status: "unavailable" },
        iab: { status: "available" },
      },
    };
  }
  if (chrome.status !== "available" || !isObject(chrome.plugin) || !isObject(chrome.nativeHost)) {
    return null;
  }
  const pluginRoot = parseNonEmptyString(chrome.plugin.root);
  const pluginManifest = parseNonEmptyString(chrome.plugin.manifest);
  const pluginVersion = parseNonEmptyString(chrome.plugin.version);
  const familyDescriptor = parseNonEmptyString(chrome.familyDescriptor);
  const installManifest = parseNonEmptyString(chrome.installManifest);
  const nativeHostPath = parseNonEmptyString(chrome.nativeHost.path);
  const hostTrust = parseHostTrust(chrome.nativeHost);
  if (
    chrome.plugin.id !== "chrome@openai-bundled" ||
    chrome.nativeHost.hostName !== "com.openai.codexextension" ||
    !pluginRoot ||
    !pluginManifest ||
    !pluginVersion ||
    !familyDescriptor ||
    !installManifest ||
    !nativeHostPath ||
    !hostTrust
  )
    return null;
  const ownedPaths = [
    pluginRoot,
    pluginManifest,
    familyDescriptor,
    installManifest,
    nativeHostPath,
  ];
  if (!ownedPaths.every(isSafeBrowserRuntimeRelativePath)) return null;
  if (
    ![pluginManifest, familyDescriptor, installManifest, nativeHostPath].every((ownedPath) =>
      ownedPath.startsWith(`${pluginRoot}/`),
    )
  ) {
    return null;
  }
  if (!Array.isArray(chrome.extensionIds) || chrome.extensionIds.length === 0) return null;
  const extensionIds = chrome.extensionIds.map(parseNonEmptyString);
  if (
    extensionIds.some((extensionId) => extensionId === null) ||
    new Set(extensionIds).size !== extensionIds.length ||
    !(extensionIds as string[]).every((extensionId) => /^[a-p]{32}$/u.test(extensionId))
  ) {
    return null;
  }
  return {
    backends: {
      chrome: {
        extensionIds: extensionIds as string[],
        familyDescriptor,
        installManifest,
        nativeHost: {
          ...hostTrust,
          hostName: chrome.nativeHost.hostName,
          path: nativeHostPath,
        },
        plugin: {
          id: chrome.plugin.id,
          manifest: pluginManifest,
          root: pluginRoot,
          version: pluginVersion,
        },
        status: "available",
      },
      iab: { status: "available" },
    },
  };
}

function parseRuntimeVersions(value: unknown): BrowserRuntimeVersions | null {
  if (!isObject(value)) return null;
  const codexCli = parseNonEmptyString(value.codexCli);
  const cuaRuntime = parseNonEmptyString(value.cuaRuntime);
  const node = parseNonEmptyString(value.node);
  if (!codexCli || !cuaRuntime || !node) return null;
  return { codexCli, cuaRuntime, node };
}

function parseSupportedBackends(value: unknown): BrowserRuntimeBackend[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry) => entry === "iab" || entry === "chrome")) return null;
  const backends = value as BrowserRuntimeBackend[];
  if (new Set(backends).size !== backends.length || !backends.includes("iab")) return null;
  return backends;
}

export function parseBrowserRuntimeManifest(value: unknown): BrowserRuntimeManifest | null {
  if (!isObject(value) || value.schemaVersion !== BROWSER_RUNTIME_SCHEMA_VERSION) return null;
  const { targetArch, targetPlatform } = value;
  if (targetArch !== "arm64" && targetArch !== "x64") return null;
  if (targetPlatform !== "darwin" && targetPlatform !== "win32") return null;
  if (targetPlatform === "darwin" && targetArch !== "arm64") return null;
  const desktopBuild = parseNonEmptyString(value.desktopBuild);
  const desktopBuildNumber = parseNonEmptyString(value.desktopBuildNumber);
  const buildFlavor = parseNonEmptyString(value.buildFlavor);
  const codexCompatibilityVersion = parseNonEmptyString(value.codexCompatibilityVersion);
  if (!desktopBuild || !desktopBuildNumber || !buildFlavor || !codexCompatibilityVersion)
    return null;

  if (!Array.isArray(value.artifacts)) return null;
  const artifacts = value.artifacts.map(parseArtifact).filter((artifact) => artifact !== null);
  if (artifacts.length !== value.artifacts.length) return null;
  const index = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  if (index.size !== artifacts.length) return null;

  const entrypoints = parseEntrypoints(value.entrypoints);
  const browserPlugin = parseBrowserPlugin(value.browserPlugin);
  const supportedBackends = parseSupportedBackends(value.supportedBackends);
  const runtimeVersions = parseRuntimeVersions(value.runtimeVersions);
  if (
    !entrypoints ||
    !browserPlugin ||
    !supportedBackends ||
    !runtimeVersions ||
    !isObject(value.capabilities) ||
    !isObject(value.entrypoints) ||
    !isObject(value.runtimeVersions) ||
    !isObject(value.trust)
  )
    return null;

  const compatible = (name: string, kind: BrowserRuntimeArtifactKind): boolean => {
    const artifact = index.get(name);
    return (
      artifact?.kind === kind &&
      (artifact.architecture === targetArch ||
        (targetPlatform === "darwin" && artifact.architecture === "universal"))
    );
  };
  if (
    !compatible(entrypoints.codexCli, "executable") ||
    !compatible(entrypoints.node, "executable") ||
    !(
      compatible(entrypoints.nodeRepl, "executable") ||
      (targetPlatform === "darwin" &&
        index.get(entrypoints.nodeRepl)?.kind === "executable" &&
        index.get(entrypoints.nodeRepl)?.architecture === "any")
    )
  )
    return null;

  const hasData = (...names: string[]) => names.every((name) => index.get(name)?.kind === "data");
  if (
    !hasData(
      browserPlugin.manifest,
      browserPlugin.client,
      browserPlugin.service,
      browserPlugin.docs,
      browserPlugin.marketplaceManifest,
    )
  )
    return null;
  const hasPlugin = (plugin: BrowserRuntimeBundledPlugin) =>
    hasData(plugin.manifest, plugin.docs, plugin.marketplaceManifest);
  const hasChrome = (
    browserUse: BrowserRuntimeBrowserUseCapability<BrowserRuntimeChromeCapability<unknown>>,
  ) => {
    const chrome = browserUse.backends.chrome;
    return chrome.status === "available"
      ? supportedBackends.includes("chrome") &&
          hasData(chrome.plugin.manifest, chrome.familyDescriptor, chrome.installManifest) &&
          compatible(chrome.nativeHost.path, "executable")
      : !supportedBackends.includes("chrome");
  };
  const common = {
    artifacts,
    browserPlugin,
    buildFlavor,
    codexCompatibilityVersion,
    desktopBuild,
    desktopBuildNumber,
    schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
    supportedBackends,
  };

  if (targetPlatform === "win32") {
    const browserUse = parseBrowserUseCapability(value.capabilities.browserUse, () => ({}));
    const computerUse = parseWindowsComputerUse(value.capabilities.computerUse);
    const sourcePackage = parseWindowsBrowserRuntimePackageIdentity(value.sourcePackage);
    const processEnumeration = parseNonEmptyString(value.entrypoints.processEnumeration);
    const pe = parseWindowsPeTrust(value.trust.pe, artifacts, targetArch);
    if (
      "nativePip" in value.capabilities ||
      "peerAuthorization" in value.entrypoints ||
      "peerAuthorization" in value.runtimeVersions ||
      Object.keys(value.trust).length !== 1 ||
      !pe ||
      !sourcePackage ||
      !browserUse ||
      !hasChrome(browserUse) ||
      !processEnumeration ||
      !compatible(processEnumeration, "native-addon") ||
      !computerUse ||
      !hasPlugin(computerUse.plugin) ||
      !compatible(computerUse.serviceExecutable, "executable") ||
      !compatible(computerUse.captureExecutable, "executable") ||
      [...browserPlugin.nodeModuleDirs, ...computerUse.plugin.nodeModuleDirs].some(
        (directory) =>
          !isSafeWindowsBrowserRuntimePath(directory) ||
          !artifacts.some((artifact) => artifact.path.startsWith(`${directory}/`)),
      )
    )
      return null;
    return {
      ...common,
      capabilities: { browserUse, computerUse },
      sourcePackage,
      entrypoints: { ...entrypoints, processEnumeration },
      runtimeVersions,
      targetArch,
      targetPlatform,
      trust: { pe },
    };
  }

  const browserUse = parseBrowserUseCapability(value.capabilities.browserUse, (host) => {
    const artifactMinimumMacOSVersion = parseNonEmptyString(host.artifactMinimumMacOSVersion);
    return artifactMinimumMacOSVersion &&
      host.productMinimumMacOSVersion === BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION
      ? {
          artifactMinimumMacOSVersion,
          productMinimumMacOSVersion:
            BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION as typeof BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
        }
      : null;
  });
  const computerUse = parseComputerUseCapability(value.capabilities.computerUse);
  const nativePip = parseNativePipCapability(value.capabilities.nativePip);
  const peerAddon = parseNonEmptyString(value.entrypoints.peerAuthorization);
  const peerAuthorization = parseNonEmptyString(value.runtimeVersions.peerAuthorization);
  const signingTeamId = parseNonEmptyString(value.trust.signingTeamId);
  const nodeApiVersion = parseNonEmptyString(value.trust.nodeApiVersion);
  const computerUseSigningTeamId = parseNonEmptyString(value.trust.computerUseSigningTeamId);
  const chromeSigningTeamId = parseNonEmptyString(value.trust.chromeSigningTeamId);
  if (
    !browserUse ||
    !hasChrome(browserUse) ||
    !computerUse ||
    !nativePip ||
    !peerAddon ||
    !compatible(peerAddon, "native-addon") ||
    !peerAuthorization ||
    !signingTeamId ||
    !nodeApiVersion ||
    !compatible(nativePip.addon, "native-addon") ||
    !hasData(...nativePip.controlAssets)
  )
    return null;
  if (browserUse.backends.chrome.status === "available" && !chromeSigningTeamId) return null;
  if (
    computerUse.status === "available" &&
    (!computerUseSigningTeamId ||
      !hasPlugin(computerUse.plugin) ||
      !hasData(computerUse.rpcService) ||
      index.get(computerUse.serviceExecutable)?.kind !== "executable")
  )
    return null;
  return {
    ...common,
    capabilities: { browserUse, computerUse, nativePip },
    entrypoints: { ...entrypoints, peerAuthorization: peerAddon },
    runtimeVersions: { ...runtimeVersions, peerAuthorization },
    targetArch: "arm64",
    targetPlatform,
    trust: {
      signingTeamId,
      nodeApiVersion,
      ...(computerUseSigningTeamId ? { computerUseSigningTeamId } : {}),
      ...(chromeSigningTeamId ? { chromeSigningTeamId } : {}),
    },
  };
}

export function parseWindowsBrowserRuntimePackageIdentity(
  value: unknown,
): WindowsBrowserRuntimePackageIdentity | null {
  if (!isObject(value)) return null;
  const name = parseNonEmptyString(value.name);
  const publisher = parseNonEmptyString(value.publisher);
  const version = parseNonEmptyString(value.version);
  return name && publisher && version && /^\d+(?:\.\d+){3}$/u.test(version)
    ? { name, publisher, version }
    : null;
}

function parseWindowsComputerUse(
  value: unknown,
): WindowsBrowserRuntimeManifest["capabilities"]["computerUse"] | null {
  if (!isObject(value) || value.status !== "available") return null;
  const plugin = parseComputerUsePlugin(value.plugin);
  const serviceExecutable = parseNonEmptyString(value.serviceExecutable);
  const captureExecutable = parseNonEmptyString(value.captureExecutable);
  const minimumWindowsVersion = value.minimumWindowsVersion;
  if (
    (minimumWindowsVersion !== undefined &&
      (typeof minimumWindowsVersion !== "string" ||
        !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(minimumWindowsVersion))) ||
    !plugin ||
    !serviceExecutable ||
    !captureExecutable ||
    serviceExecutable === captureExecutable
  )
    return null;
  return {
    status: "available",
    plugin,
    serviceExecutable,
    captureExecutable,
    ...(minimumWindowsVersion === undefined ? {} : { minimumWindowsVersion }),
  };
}

function parseWindowsPeTrust(
  value: unknown,
  artifacts: readonly BrowserRuntimeArtifact[],
  arch: WindowsBrowserRuntimeArch,
): Record<string, WindowsBrowserRuntimePe> | null {
  if (!isObject(value)) return null;
  const pe = new Map<string, WindowsBrowserRuntimePe>();
  const spellings = new Map<string, string>();
  const files = new Set(artifacts.map((artifact) => artifact.path));
  for (const artifact of artifacts) {
    if (!isSafeWindowsBrowserRuntimePath(artifact.path)) return null;
    let prefix = "";
    for (const segment of artifact.path.split("/")) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const key = prefix.toLowerCase();
      const prior = spellings.get(key);
      if ((prior && prior !== prefix) || (prefix !== artifact.path && files.has(prefix)))
        return null;
      spellings.set(key, prefix);
    }
    if (artifact.kind === "data") {
      if (/\.(exe|dll|node)$/iu.test(artifact.path)) return null;
      continue;
    }
    const entry = value[artifact.path];
    if (
      !isObject(entry) ||
      !isObject(entry.publisher) ||
      entry.machine !== arch ||
      artifact.architecture !== arch ||
      Object.keys(entry.publisher).length !== 2
    )
      return null;
    const subject = parseNonEmptyString(entry.publisher.subject);
    const issuer = parseNonEmptyString(entry.publisher.issuer);
    if (!subject || !issuer) return null;
    pe.set(artifact.path, { machine: arch, publisher: { subject, issuer } });
  }
  return pe.size === Object.keys(value).length ? Object.fromEntries(pe) : null;
}
