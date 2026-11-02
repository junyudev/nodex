import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_ELECTRON_OPAQUE_DARK_BACKGROUND_COLOR,
  CODEX_ELECTRON_OPAQUE_LIGHT_BACKGROUND_COLOR,
  CODEX_ELECTRON_TRANSPARENT_BACKGROUND_COLOR,
  supportsWindowsMica,
  resolveElectronWindowBackdrop,
  shouldUseOpaqueElectronWindowSurface,
} from "./electron-window-backdrop";

describe("electron window backdrop", () => {
  test("keeps focused small macOS windows transparent", () => {
    expect(
      shouldUseOpaqueElectronWindowSurface({
        bounds: { width: 1474, height: 1078 },
        isFocused: true,
        platform: "darwin",
        prefersReducedTransparency: false,
        scaleFactor: 2,
      }),
    ).toBe(false);
  });

  test("uses opaque surfaces for large physical macOS windows", () => {
    expect(
      shouldUseOpaqueElectronWindowSurface({
        bounds: { width: 1920, height: 1080 },
        isFocused: true,
        platform: "darwin",
        prefersReducedTransparency: false,
        scaleFactor: 2,
      }),
    ).toBe(true);
  });

  test("keeps Mica on blur while macOS becomes opaque", () => {
    expect(
      shouldUseOpaqueElectronWindowSurface({
        bounds: { width: 1200, height: 800 },
        isFocused: false,
        platform: "darwin",
        prefersReducedTransparency: false,
        scaleFactor: 2,
      }),
    ).toBe(true);
    expect(
      shouldUseOpaqueElectronWindowSurface({
        bounds: { width: 1200, height: 800 },
        isFocused: false,
        platform: "win32",
        prefersReducedTransparency: false,
        scaleFactor: 1,
      }),
    ).toBe(false);
  });

  test("keeps focused small Windows windows transparent", () => {
    expect(
      shouldUseOpaqueElectronWindowSurface({
        bounds: { width: 1200, height: 800 },
        isFocused: true,
        platform: "win32",
        prefersReducedTransparency: false,
        scaleFactor: 1,
      }),
    ).toBe(false);
  });

  test("resolves transparent and opaque native backdrop settings", () => {
    const transparentMac = resolveElectronWindowBackdrop({
      bounds: { width: 1200, height: 800 },
      isFocused: true,
      platform: "darwin",
      prefersDarkColors: false,
      prefersReducedTransparency: false,
      scaleFactor: 2,
    });
    expect(transparentMac.backgroundColor).toBe(CODEX_ELECTRON_TRANSPARENT_BACKGROUND_COLOR);
    expect(transparentMac.backgroundMaterial).toBe(null);
    expect(transparentMac.vibrancy).toBe("menu");

    const transparentWindows = resolveElectronWindowBackdrop({
      bounds: { width: 1200, height: 800 },
      isFocused: true,
      platform: "win32",
      prefersDarkColors: false,
      prefersReducedTransparency: false,
      scaleFactor: 1,
    });
    expect(transparentWindows.backgroundColor).toBe(CODEX_ELECTRON_TRANSPARENT_BACKGROUND_COLOR);
    expect(transparentWindows.backgroundMaterial).toBe("mica");
    expect(transparentWindows.vibrancy).toBe(null);

    const opaqueLight = resolveElectronWindowBackdrop({
      bounds: { width: 1200, height: 800 },
      forceOpaque: true,
      isFocused: true,
      platform: "darwin",
      prefersDarkColors: false,
      prefersReducedTransparency: false,
      scaleFactor: 2,
    });
    expect(opaqueLight.backgroundColor).toBe(CODEX_ELECTRON_OPAQUE_LIGHT_BACKGROUND_COLOR);
    expect(opaqueLight.vibrancy).toBe(null);

    const opaqueDark = resolveElectronWindowBackdrop({
      bounds: { width: 1200, height: 800 },
      forceOpaque: true,
      isFocused: true,
      platform: "darwin",
      prefersDarkColors: true,
      prefersReducedTransparency: false,
      scaleFactor: 2,
    });
    expect(opaqueDark.backgroundColor).toBe(CODEX_ELECTRON_OPAQUE_DARK_BACKGROUND_COLOR);
    expect(opaqueDark.vibrancy).toBe(null);
  });

  test("honors macOS Reduce transparency", () => {
    const backdrop = resolveElectronWindowBackdrop({
      bounds: { width: 1200, height: 800 },
      isFocused: true,
      platform: "darwin",
      prefersDarkColors: false,
      prefersReducedTransparency: true,
      scaleFactor: 2,
    });

    expect(backdrop.opaqueWindowSurfaceEnabled).toBe(true);
    expect(backdrop.backgroundColor).toBe(CODEX_ELECTRON_OPAQUE_LIGHT_BACKGROUND_COLOR);
    expect(backdrop.vibrancy).toBe(null);
  });
});

test.each([
  ["10.0.22621", "enabled", true],
  ["10.0.26100", "enabled", true],
  ["10.0.22000", "enabled", false],
  ["10.0.19045", "enabled", false],
  ["10.0.26100", "disabled_software", false],
  ["invalid", "enabled", false],
] as const)("Windows backdrop capability %s/%s", (release, gpu, supported) => {
  expect(supportsWindowsMica(release, gpu)).toBe(supported);
});
test("an unsupported Windows backdrop paints an opaque themed surface", () => {
  const backdrop = resolveElectronWindowBackdrop({
    bounds: { width: 1200, height: 800 },
    isFocused: true,
    platform: "win32",
    prefersReducedTransparency: false,
    scaleFactor: 1,
    prefersDarkColors: true,
    backdropSupported: false,
  });
  expect(backdrop).toMatchObject({
    backgroundColor: "#000000",
    backgroundMaterial: "none",
    opaqueWindowSurfaceEnabled: true,
  });
});
