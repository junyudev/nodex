import type { ChromeBrowserFamilyDescriptor } from "./ChromeBrowserFamilyRegistry";
import type { ChromeExtensionInstanceSnapshot } from "./ChromeExtensionPipeRegistry";
import type { ChromeControlRuntimeStatus } from "../../../shared/chrome-control-settings";

export const BROWSER_CONNECTIONS_COMMAND = "nodex_browser_connections";

export interface DefaultBrowserIdentity {
  readonly name: string;
  readonly applicationId: string | null;
}

export interface BrowserConnectionInventory {
  readonly families: readonly ChromeBrowserFamilyDescriptor[];
  readonly instances: readonly ChromeExtensionInstanceSnapshot[];
  readonly status: ChromeControlRuntimeStatus;
  readonly runningFamilies?: ReadonlyMap<string, boolean>;
}

type BrowserConnectionState = "connected" | "disconnected" | "unknown" | "unsupported";

export interface BrowserConnectionFacts {
  readonly defaultBrowser: {
    readonly name: string;
    readonly family: string | null;
    readonly supported: boolean | null;
    readonly connection: BrowserConnectionState;
    readonly running: boolean | null;
  } | null;
  readonly supportedBrowsers: readonly {
    readonly family: string;
    readonly name: string;
    readonly connection: BrowserConnectionState;
    readonly running: boolean | null;
  }[];
  readonly connectedBrowsers: readonly {
    readonly family: string | null;
    readonly name: string;
    readonly extensionInstanceId: string;
  }[];
  readonly extensionControl: ChromeControlRuntimeStatus;
}

export function projectBrowserConnectionFacts(
  platform: NodeJS.Platform,
  identity: DefaultBrowserIdentity | null,
  inventory: BrowserConnectionInventory,
): BrowserConnectionFacts {
  const families = inventory.families.filter(
    (family) => platform !== "win32" || family.windows?.registrationBrowser,
  );

  const connectedBrowsers = inventory.instances.map((instance) => {
    // The extension reports "chrome" for several Chromium apps. Only a verified
    // process can turn an ambiguous macOS report into an app-specific selector.
    const family =
      instance.application?.family ??
      (platform === "darwin" && instance.family === "chrome" ? null : instance.family);
    return {
      family,
      name:
        families.find((browser) => browser.family === family)?.shortDisplayName ??
        "Chromium browser (app identity unavailable)",
      extensionInstanceId: instance.extensionInstanceId,
    };
  });
  const applicationId = identity?.applicationId;
  const defaultFamily = applicationId
    ? families.find((family) =>
        platform === "win32"
          ? family.windows?.processNames.some(
              (name) => name.toLowerCase() === applicationId.toLowerCase(),
            )
          : family.bundleId === applicationId,
      )
    : undefined;
  const supported = applicationId && families.length > 0 ? defaultFamily !== undefined : null;
  const hasUnattributedBrowser = connectedBrowsers.some(({ family }) => family === null);
  const connectionFor = (family: string): BrowserConnectionState =>
    connectedBrowsers.some((browser) => browser.family === family)
      ? "connected"
      : hasUnattributedBrowser
        ? "unknown"
        : "disconnected";
  const running = (family: string): boolean | null =>
    connectionFor(family) === "connected" ? true : (inventory.runningFamilies?.get(family) ?? null);
  const defaultConnection = defaultFamily
    ? connectionFor(defaultFamily.family)
    : supported === false
      ? "unsupported"
      : "unknown";
  return {
    defaultBrowser: identity
      ? {
          name: identity.name,
          supported,
          family: defaultFamily?.family ?? null,
          connection: defaultConnection,
          running: defaultFamily ? running(defaultFamily.family) : null,
        }
      : null,
    supportedBrowsers: families.map(({ family, shortDisplayName: name }) => ({
      family,
      name,
      connection: connectionFor(family),
      running: running(family),
    })),
    connectedBrowsers,
    extensionControl: inventory.status,
  };
}

export function preferredBrowserExtension(facts: BrowserConnectionFacts): string | undefined {
  if (facts.defaultBrowser?.connection !== "connected") return undefined;
  const candidates = facts.connectedBrowsers.filter(
    (browser) => browser.family === facts.defaultBrowser?.family,
  );
  return candidates.length === 1 ? candidates[0]?.extensionInstanceId : undefined;
}
