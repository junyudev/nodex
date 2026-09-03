export const BROWSER_RUNTIME_BUNDLE_DIRECTORY = "browser-runtime";
export const BROWSER_RUNTIME_MANIFEST_FILENAME = "browser-runtime-manifest.json";
export const BROWSER_RUNTIME_SCHEMA_VERSION = 6;
const LEGACY_BROWSER_RUNTIME_SCHEMA_VERSION = 5;
export const BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION = "15.0";
export const BROWSER_PLUGIN_NODE_MODULE_DIR = "marketplace/plugins/browser/node_modules";

export type BrowserRuntimeArtifactArchitecture = "any" | "arm64" | "universal" | "x64";
export type BrowserRuntimeArtifactKind = "data" | "executable" | "native-addon";
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
      client: string;
      ipcProtocol: "CodexComputerUseIPC-5";
      plugin: BrowserRuntimeBundledPlugin;
      productMinimumMacOSVersion: typeof BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION;
      rpcService: string;
      serviceExecutable: string;
      signingTeamId: string;
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

export type BrowserRuntimeChromeCapability =
  | { reason: "not-bundled"; status: "unavailable" }
  | {
      extensionIds: string[];
      familyDescriptor: string;
      installManifest: string;
      nativeHost: {
        artifactMinimumMacOSVersion: string;
        hostName: "com.openai.codexextension";
        path: string;
        productMinimumMacOSVersion: typeof BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION;
        signingTeamId: string;
      };
      plugin: {
        id: "chrome@openai-bundled";
        manifest: string;
        root: string;
        version: string;
      };
      status: "available";
    };

export type BrowserRuntimeBrowserUseCapability = {
  backends: {
    chrome: BrowserRuntimeChromeCapability;
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

export type BrowserRuntimeManifest = {
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
  capabilities: {
    browserUse: BrowserRuntimeBrowserUseCapability;
    computerUse: BrowserRuntimeComputerUseCapability;
    nativePip: BrowserRuntimeNativePipCapability;
  };
  buildFlavor: string;
  codexCompatibilityVersion: string;
  desktopBuild: string;
  desktopBuildNumber: string;
  entrypoints: {
    codexCli: string;
    node: string;
    nodeRepl: string;
    peerAuthorization: string;
  };
  peerAuthorization: {
    nodeApiVersion: string;
    signingTeamId: string;
  };
  runtimeVersions: {
    codexCli: string;
    cuaRuntime: string;
    node: string;
    peerAuthorization: string;
  };
  schemaVersion: typeof BROWSER_RUNTIME_SCHEMA_VERSION;
  supportedBackends: BrowserRuntimeBackend[];
  targetArch: "arm64" | "x64";
  targetPlatform: "darwin" | "linux" | "win32";
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeBrowserRuntimeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
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
  if (!["data", "executable", "native-addon"].includes(String(value.kind))) return null;

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

function parseEntrypoints(value: unknown): BrowserRuntimeManifest["entrypoints"] | null {
  if (!isObject(value)) return null;
  const codexCli = parseNonEmptyString(value.codexCli);
  const node = parseNonEmptyString(value.node);
  const nodeRepl = parseNonEmptyString(value.nodeRepl);
  const peerAuthorization = parseNonEmptyString(value.peerAuthorization);
  if (!codexCli || !node || !nodeRepl || !peerAuthorization) return null;
  if (![codexCli, node, nodeRepl, peerAuthorization].every(isSafeBrowserRuntimeRelativePath)) {
    return null;
  }
  if (new Set([codexCli, node, nodeRepl, peerAuthorization]).size !== 4) return null;
  return { codexCli, node, nodeRepl, peerAuthorization };
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

function parseNativePipCapability(
  value: unknown,
  schemaVersion: number,
): BrowserRuntimeNativePipCapability | null {
  if (!isObject(value)) return null;
  const isLegacy = schemaVersion === LEGACY_BROWSER_RUNTIME_SCHEMA_VERSION;
  if (
    isLegacy
      ? value.minimumMacOSVersion !== "13.0"
      : value.status !== "available" ||
        value.artifactMinimumMacOSVersion !== "13.0" ||
        value.productMinimumMacOSVersion !== BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION
  ) {
    return null;
  }
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
  let expectedExports: string[];
  if (isLegacy) {
    expectedExports = [...BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS];
  } else {
    if (!isObject(value.exports) || !Array.isArray(value.exports.expectedExports)) return null;
    expectedExports = value.exports.expectedExports.map((entry) =>
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

function parseComputerUseCapability(
  value: unknown,
  schemaVersion: number,
): BrowserRuntimeComputerUseCapability | null {
  if (!isObject(value)) return null;
  if (value.status === "unavailable") {
    return value.reason === "architecture-unsupported"
      ? { reason: value.reason, status: value.status }
      : null;
  }
  const isLegacy = schemaVersion === LEGACY_BROWSER_RUNTIME_SCHEMA_VERSION;
  if (value.status !== "available") return null;
  if (
    isLegacy
      ? value.minimumMacOSVersion !== "14.4" || value.ipcProtocol !== "CodexComputerUseIPC-2"
      : value.artifactMinimumMacOSVersion !== "14.4" ||
        value.productMinimumMacOSVersion !== BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION ||
        value.ipcProtocol !== "CodexComputerUseIPC-5"
  ) {
    return null;
  }
  const appBundle = parseNonEmptyString(value.appBundle);
  const appBundleIdentifier = parseNonEmptyString(value.appBundleIdentifier);
  const client = parseNonEmptyString(value.client);
  const rpcService = parseNonEmptyString(value.rpcService);
  const serviceExecutable = parseNonEmptyString(value.serviceExecutable);
  const signingTeamId = parseNonEmptyString(value.signingTeamId);
  const plugin = parseComputerUsePlugin(value.plugin);
  if (
    !appBundle ||
    !appBundleIdentifier ||
    !client ||
    !rpcService ||
    !serviceExecutable ||
    !signingTeamId ||
    !plugin
  ) {
    return null;
  }
  if (![appBundle, client, rpcService, serviceExecutable].every(isSafeBrowserRuntimeRelativePath)) {
    return null;
  }
  if (!serviceExecutable.startsWith(`${appBundle}/`)) return null;
  if (!client.startsWith(`${plugin.root}/`)) return null;
  if (!rpcService.startsWith(`${plugin.nodeModuleDirs[0]}/`)) return null;
  return {
    appBundle,
    appBundleIdentifier,
    artifactMinimumMacOSVersion: "14.4",
    client,
    ipcProtocol: "CodexComputerUseIPC-5",
    plugin,
    productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
    rpcService,
    serviceExecutable,
    signingTeamId,
    status: value.status,
  };
}

function parseBrowserUseCapability(
  value: unknown,
  supportedBackends: readonly BrowserRuntimeBackend[],
  schemaVersion: number,
): BrowserRuntimeBrowserUseCapability | null {
  if (schemaVersion === LEGACY_BROWSER_RUNTIME_SCHEMA_VERSION) {
    return supportedBackends.includes("iab")
      ? {
          backends: {
            chrome: { reason: "not-bundled", status: "unavailable" },
            iab: { status: "available" },
          },
        }
      : null;
  }
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
  const signingTeamId = parseNonEmptyString(chrome.nativeHost.signingTeamId);
  const artifactMinimumMacOSVersion = parseNonEmptyString(
    chrome.nativeHost.artifactMinimumMacOSVersion,
  );
  if (
    chrome.plugin.id !== "chrome@openai-bundled" ||
    chrome.nativeHost.hostName !== "com.openai.codexextension" ||
    chrome.nativeHost.productMinimumMacOSVersion !==
      BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION ||
    !pluginRoot ||
    !pluginManifest ||
    !pluginVersion ||
    !familyDescriptor ||
    !installManifest ||
    !nativeHostPath ||
    !signingTeamId ||
    !artifactMinimumMacOSVersion
  ) {
    return null;
  }
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
          artifactMinimumMacOSVersion,
          hostName: chrome.nativeHost.hostName,
          path: nativeHostPath,
          productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
          signingTeamId,
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

function parseRuntimeVersions(value: unknown): BrowserRuntimeManifest["runtimeVersions"] | null {
  if (!isObject(value)) return null;
  const codexCli = parseNonEmptyString(value.codexCli);
  const cuaRuntime = parseNonEmptyString(value.cuaRuntime);
  const node = parseNonEmptyString(value.node);
  const peerAuthorization = parseNonEmptyString(value.peerAuthorization);
  if (!codexCli || !cuaRuntime || !node || !peerAuthorization) return null;
  return { codexCli, cuaRuntime, node, peerAuthorization };
}

function parsePeerAuthorization(
  value: unknown,
): BrowserRuntimeManifest["peerAuthorization"] | null {
  if (!isObject(value)) return null;
  const nodeApiVersion = parseNonEmptyString(value.nodeApiVersion);
  const signingTeamId = parseNonEmptyString(value.signingTeamId);
  if (!nodeApiVersion || !signingTeamId) return null;
  return { nodeApiVersion, signingTeamId };
}

function parseSupportedBackends(value: unknown): BrowserRuntimeBackend[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry) => entry === "iab" || entry === "chrome")) return null;
  const backends = value as BrowserRuntimeBackend[];
  if (new Set(backends).size !== backends.length || !backends.includes("iab")) return null;
  return backends;
}

export function parseBrowserRuntimeManifest(value: unknown): BrowserRuntimeManifest | null {
  if (!isObject(value)) return null;
  if (
    value.schemaVersion !== BROWSER_RUNTIME_SCHEMA_VERSION &&
    value.schemaVersion !== LEGACY_BROWSER_RUNTIME_SCHEMA_VERSION
  ) {
    return null;
  }
  const sourceSchemaVersion = value.schemaVersion;
  if (value.targetArch !== "arm64" && value.targetArch !== "x64") return null;
  if (!["darwin", "linux", "win32"].includes(String(value.targetPlatform))) return null;

  const desktopBuild = parseNonEmptyString(value.desktopBuild);
  const desktopBuildNumber = parseNonEmptyString(value.desktopBuildNumber);
  const buildFlavor = parseNonEmptyString(value.buildFlavor);
  const codexCompatibilityVersion = parseNonEmptyString(value.codexCompatibilityVersion);
  if (!desktopBuild || !desktopBuildNumber || !buildFlavor || !codexCompatibilityVersion)
    return null;

  if (!Array.isArray(value.artifacts)) return null;
  const artifacts = value.artifacts.map(parseArtifact);
  if (artifacts.some((artifact) => artifact === null)) return null;
  const parsedArtifacts = artifacts as BrowserRuntimeArtifact[];
  const artifactsByPath = new Map(parsedArtifacts.map((artifact) => [artifact.path, artifact]));
  if (artifactsByPath.size !== parsedArtifacts.length) return null;

  const entrypoints = parseEntrypoints(value.entrypoints);
  const browserPlugin = parseBrowserPlugin(value.browserPlugin);
  const supportedBackends = parseSupportedBackends(value.supportedBackends);
  if (!supportedBackends) return null;
  const capabilities = isObject(value.capabilities)
    ? {
        browserUse: parseBrowserUseCapability(
          value.capabilities.browserUse,
          supportedBackends,
          sourceSchemaVersion,
        ),
        computerUse: parseComputerUseCapability(
          value.capabilities.computerUse,
          sourceSchemaVersion,
        ),
        nativePip: parseNativePipCapability(value.capabilities.nativePip, sourceSchemaVersion),
      }
    : null;
  const peerAuthorization = parsePeerAuthorization(value.peerAuthorization);
  const runtimeVersions = parseRuntimeVersions(value.runtimeVersions);
  if (
    !entrypoints ||
    !browserPlugin ||
    !capabilities?.browserUse ||
    !capabilities.computerUse ||
    !capabilities.nativePip ||
    !peerAuthorization ||
    !runtimeVersions ||
    !supportedBackends
  )
    return null;

  const targetArch = value.targetArch;
  const isCompatibleBinary = (artifact: BrowserRuntimeArtifact | undefined): boolean =>
    artifact !== undefined &&
    (artifact.architecture === targetArch || artifact.architecture === "universal");
  const codexCli = artifactsByPath.get(entrypoints.codexCli);
  const node = artifactsByPath.get(entrypoints.node);
  const nodeRepl = artifactsByPath.get(entrypoints.nodeRepl);
  const peerAddon = artifactsByPath.get(entrypoints.peerAuthorization);
  if (
    !isCompatibleBinary(codexCli) ||
    codexCli?.kind !== "executable" ||
    !isCompatibleBinary(node) ||
    node?.kind !== "executable" ||
    nodeRepl?.kind !== "executable" ||
    !(
      nodeRepl.architecture === "any" ||
      nodeRepl.architecture === targetArch ||
      nodeRepl.architecture === "universal"
    ) ||
    !isCompatibleBinary(peerAddon) ||
    peerAddon?.kind !== "native-addon"
  ) {
    return null;
  }

  const pluginArtifacts = [
    artifactsByPath.get(browserPlugin.manifest),
    artifactsByPath.get(browserPlugin.client),
    artifactsByPath.get(browserPlugin.service),
    artifactsByPath.get(browserPlugin.docs),
    artifactsByPath.get(browserPlugin.marketplaceManifest),
  ];
  if (pluginArtifacts.some((artifact) => artifact?.kind !== "data")) return null;

  const chrome = capabilities.browserUse.backends.chrome;
  if (chrome.status === "available") {
    const chromeArtifacts = [
      artifactsByPath.get(chrome.plugin.manifest),
      artifactsByPath.get(chrome.familyDescriptor),
      artifactsByPath.get(chrome.installManifest),
    ];
    if (chromeArtifacts.some((artifact) => artifact?.kind !== "data")) return null;
    const nativeHost = artifactsByPath.get(chrome.nativeHost.path);
    if (!isCompatibleBinary(nativeHost) || nativeHost?.kind !== "executable") return null;
    if (!supportedBackends.includes("chrome")) return null;
  } else if (supportedBackends.includes("chrome")) {
    return null;
  }

  const nativePipAddon = artifactsByPath.get(capabilities.nativePip.addon);
  if (!isCompatibleBinary(nativePipAddon) || nativePipAddon?.kind !== "native-addon") return null;
  if (
    capabilities.nativePip.controlAssets.some(
      (assetPath) => artifactsByPath.get(assetPath)?.kind !== "data",
    )
  ) {
    return null;
  }

  if (capabilities.computerUse.status === "available") {
    if (targetArch !== "arm64" || value.targetPlatform !== "darwin") return null;
    const computerUseArtifacts = [
      artifactsByPath.get(capabilities.computerUse.plugin.manifest),
      artifactsByPath.get(capabilities.computerUse.plugin.docs),
      artifactsByPath.get(capabilities.computerUse.plugin.marketplaceManifest),
      artifactsByPath.get(capabilities.computerUse.client),
      artifactsByPath.get(capabilities.computerUse.rpcService),
      artifactsByPath.get(capabilities.computerUse.serviceExecutable),
    ];
    if (computerUseArtifacts.some((artifact) => artifact === undefined)) return null;
    if (computerUseArtifacts.slice(0, 3).some((artifact) => artifact?.kind !== "data")) return null;
    if (
      computerUseArtifacts[3]?.kind !== "data" &&
      computerUseArtifacts[3]?.kind !== "executable"
    ) {
      return null;
    }
    if (computerUseArtifacts[4]?.kind !== "data") return null;
    if (computerUseArtifacts[5]?.kind !== "executable") return null;
  }
  if (targetArch === "x64" && capabilities.computerUse.status !== "unavailable") return null;

  return {
    artifacts: parsedArtifacts,
    browserPlugin,
    buildFlavor,
    capabilities: {
      browserUse: capabilities.browserUse,
      computerUse: capabilities.computerUse,
      nativePip: capabilities.nativePip,
    },
    codexCompatibilityVersion,
    desktopBuild,
    desktopBuildNumber,
    entrypoints,
    peerAuthorization,
    runtimeVersions,
    schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
    supportedBackends: chrome.status === "available" ? ["iab", "chrome"] : ["iab"],
    targetArch,
    targetPlatform: value.targetPlatform as BrowserRuntimeManifest["targetPlatform"],
  };
}
