export const CODEX_ELECTRON_OPAQUE_LONG_EDGE_PHYSICAL_PX = 3840;
export const CODEX_ELECTRON_OPAQUE_SHORT_EDGE_PHYSICAL_PX = 2160;
export const CODEX_ELECTRON_TRANSPARENT_BACKGROUND_COLOR = "#00000000";
export const CODEX_ELECTRON_OPAQUE_DARK_BACKGROUND_COLOR = "#000000";
export const CODEX_ELECTRON_OPAQUE_LIGHT_BACKGROUND_COLOR = "#f9f9f9";

export interface ElectronWindowBackdropBounds {
  width: number;
  height: number;
}

export interface ShouldUseOpaqueElectronWindowSurfaceInput {
  bounds: ElectronWindowBackdropBounds;
  forceOpaque?: boolean;
  backdropSupported?: boolean;
  isFocused: boolean;
  platform: NodeJS.Platform;
  prefersReducedTransparency: boolean;
  scaleFactor: number;
}

export interface ResolveElectronWindowBackdropInput extends ShouldUseOpaqueElectronWindowSurfaceInput {
  prefersDarkColors: boolean;
}

export interface ElectronWindowBackdrop {
  backgroundColor: string;
  backgroundMaterial: "mica" | "none" | null;
  opaqueWindowSurfaceEnabled: boolean;
  vibrancy: "menu" | null;
}

function supportsOpaqueSurface(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function shouldUseOpaqueElectronWindowSurface(
  input: ShouldUseOpaqueElectronWindowSurfaceInput,
): boolean {
  if (!supportsOpaqueSurface(input.platform)) return false;
  if (input.forceOpaque === true) return true;
  if (input.platform === "darwin" && input.prefersReducedTransparency) return true;
  if (input.platform === "win32" && input.backdropSupported === false) return true;
  if (input.platform === "darwin" && !input.isFocused) return true;
  if (input.platform !== "darwin") return false;

  const physicalWidth = input.bounds.width * input.scaleFactor;
  const physicalHeight = input.bounds.height * input.scaleFactor;
  const longEdge = Math.max(physicalWidth, physicalHeight);
  const shortEdge = Math.min(physicalWidth, physicalHeight);

  return (
    longEdge >= CODEX_ELECTRON_OPAQUE_LONG_EDGE_PHYSICAL_PX &&
    shortEdge >= CODEX_ELECTRON_OPAQUE_SHORT_EDGE_PHYSICAL_PX
  );
}

export function resolveElectronWindowBackdrop(
  input: ResolveElectronWindowBackdropInput,
): ElectronWindowBackdrop {
  const opaqueWindowSurfaceEnabled = shouldUseOpaqueElectronWindowSurface(input);
  if (opaqueWindowSurfaceEnabled) {
    return {
      backgroundColor: input.prefersDarkColors
        ? CODEX_ELECTRON_OPAQUE_DARK_BACKGROUND_COLOR
        : CODEX_ELECTRON_OPAQUE_LIGHT_BACKGROUND_COLOR,
      backgroundMaterial: input.platform === "win32" ? "none" : null,
      opaqueWindowSurfaceEnabled,
      vibrancy: null,
    };
  }

  if (input.platform === "win32") {
    return {
      backgroundColor: CODEX_ELECTRON_TRANSPARENT_BACKGROUND_COLOR,
      backgroundMaterial: "mica",
      opaqueWindowSurfaceEnabled,
      vibrancy: null,
    };
  }

  return {
    backgroundColor: CODEX_ELECTRON_TRANSPARENT_BACKGROUND_COLOR,
    backgroundMaterial: null,
    opaqueWindowSurfaceEnabled,
    vibrancy: input.platform === "darwin" ? "menu" : null,
  };
}

/** Electron supports Mica on Windows 11 22H2+, with GPU compositing enabled. */
export function supportsWindowsMica(release: string, gpuCompositing: string): boolean {
  const [major = 0, , build = 0] = release.split(".").map(Number);
  return (major > 10 || (major === 10 && build >= 22621)) && gpuCompositing === "enabled";
}
