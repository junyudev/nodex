import { createRequire } from "node:module";
import path from "node:path";
import { BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS } from "../shared/browser-runtime-metadata";
import type {
  RemoteHostedPipAnchor,
  RemoteHostedPipPresentationScope,
  RemoteHostedPipViewportRect,
} from "../shared/remote-hosted-pip";

export interface SkyRemoteHostedPipHostRegistration {
  anchors: RemoteHostedPipAnchor[] | null;
  anchorRect: RemoteHostedPipViewportRect | null;
  animated: boolean;
  contentBounds: RemoteHostedPipViewportRect;
  id: string;
  isCodexHomeAvailable: boolean;
  interactionPassthroughRect?: RemoteHostedPipViewportRect | null;
  nativeWindowHandle: Buffer | null;
  presentationScope: RemoteHostedPipPresentationScope;
  title: string;
  animationSpring?: {
    damping: number;
    initialVelocity: number;
    mass: number;
    stiffness: number;
  } | null;
}

export interface SkyNativeAddon {
  completeRemoteHostedPIPContentThread(threadId: string): boolean;
  computerUseServiceProcessMatchesExecutablePath(pid: number, executablePath: string): boolean;
  connectRemoteHostedPIPContentHost(pid: number): boolean;
  getRemoteHostedPIPContentActiveTaskIDs(): string[];
  getRemoteHostedPIPContentLayoutState(): unknown;
  hasRemoteHostedPIPContentAnyPresentation(): boolean;
  invalidateBrowserUsePIPContent(presentationId: string): boolean;
  invalidateRemoteHostedPIPContentTurn(threadId: string, turnId: string): boolean;
  isPrivacySettingsTerminationRequest(): boolean;
  refreshRemoteHostedPIPContentVisibility(threadIds?: string[]): boolean;
  registerRemoteHostedPIPContentHost(input: SkyRemoteHostedPipHostRegistration): boolean;
  setBrowserUsePIPContentClickHandler(handler: ((presentationId: string) => void) | null): boolean;
  setRemoteHostedPIPContentActiveThreadID(threadId: string | null): boolean;
  setRemoteHostedPIPContentComputerUseCursorLocationHandler(
    handler: ((point: { x: number; y: number } | null) => void) | null,
  ): boolean;
  setRemoteHostedPIPContentMaxDisplaySize(size: number): boolean;
  setRemoteHostedPIPContentMaxDisplaySizeChangedHandler(
    handler: ((size: number) => void) | null,
  ): boolean;
  setRemoteHostedPIPContentLayoutStateChangedHandler(
    handler: ((layoutState: unknown) => void) | null,
  ): boolean;
  setRemoteHostedPIPContentPetWakeRequestHandler(handler: (() => void) | null): boolean;
  setRemoteHostedPIPContentShouldShowTaskHandler(
    handler: ((threadId: string) => boolean) | null,
  ): boolean;
  setRemoteHostedPIPContentSuppressedThreadIDs(threadIds: string[]): boolean;
  setRemoteHostedPIPContentVisibilityRequestHandler(
    handler: ((isVisible: boolean, threadIds: string[]) => void) | null,
  ): boolean;
  spawnComputerUseService(executablePath: string): Promise<number | null>;
  startRemoteHostedPIPContentHost(
    tooltips: {
      closeTooltip: string;
      hide: string;
      hideForAllActiveTasks: string;
      hideForTask: string;
      placementTooltip: string;
    },
    onServiceConnectionLost?: () => void,
  ): boolean;
  stopRemoteHostedPIPContentHost(): boolean;
  unregisterRemoteHostedPIPContentHost(hostId: string): boolean;
  upsertBrowserUsePIPContent(
    presentationId: string,
    threadId: string,
    imageDataUrl: string,
    appIconPath: string | null,
  ): boolean;
}

const requireFromMain = createRequire(import.meta.url);

export type SkyNativeCapabilityGroup = keyof typeof BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS;

export function inspectSkyNativeCapabilities(
  value: unknown,
): Readonly<Record<SkyNativeCapabilityGroup, boolean>> {
  const candidate =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS).map(([group, exportNames]) => [
      group,
      exportNames.every((exportName) => typeof candidate[exportName] === "function"),
    ]),
  ) as unknown as Readonly<Record<SkyNativeCapabilityGroup, boolean>>;
}

function hasRequiredExports(
  value: unknown,
  expectedExportContract: readonly string[],
): value is SkyNativeAddon {
  if (typeof value !== "object" || value === null) return false;
  const actualExports = Object.keys(value).sort();
  const expectedExports = [...expectedExportContract].sort();
  return (
    actualExports.length === expectedExports.length &&
    actualExports.every((exportName, index) => exportName === expectedExports[index]) &&
    Object.values(inspectSkyNativeCapabilities(value)).every(Boolean)
  );
}

/** Loads only the absolute path admitted by BrowserRuntimeBundle verification. */
export function loadSkyNativeAddon(
  verifiedAddonPath?: string,
  expectedExports?: readonly string[],
): SkyNativeAddon | null {
  if (process.platform !== "darwin") return null;
  if (!verifiedAddonPath || !path.isAbsolute(verifiedAddonPath)) return null;
  if (!expectedExports || expectedExports.length === 0) return null;
  try {
    const addon = requireFromMain(verifiedAddonPath) as unknown;
    return hasRequiredExports(addon, expectedExports) ? addon : null;
  } catch {
    return null;
  }
}

export function isMacOSVersionAtLeast(
  minimumVersion: string,
  release = process.getSystemVersion?.() ?? "0",
): boolean {
  const expected = minimumVersion.split(".").map(Number);
  const actual = release.split(".").map(Number);
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (actual[index] ?? 0) - (expected[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
