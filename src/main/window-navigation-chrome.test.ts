import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_TITLEBAR_OVERLAY_COLOR,
  resolveCodexTitleBarOptions,
  resolveCodexTitleBarOverlay,
  resolveCodexTrafficLightPosition,
} from "./window-navigation-chrome";

describe("window navigation chrome", () => {
  test("centers macOS traffic lights in the shared titlebar", () => {
    const position = resolveCodexTrafficLightPosition(1);

    expect(position.x).toBe(16);
    expect(position.y).toBe(15);
  });

  test("uses zoom-aware macOS traffic-light positioning", () => {
    const position = resolveCodexTrafficLightPosition(1.25);

    expect(position.x).toBe(16);
    expect(position.y).toBe(21);
  });

  test("uses a transparent Windows titlebar overlay with theme symbols", () => {
    const lightOverlay = resolveCodexTitleBarOverlay(1, false);
    const darkOverlay = resolveCodexTitleBarOverlay(1.5, true);

    expect(lightOverlay.color).toBe(CODEX_TITLEBAR_OVERLAY_COLOR);
    expect(lightOverlay.symbolColor).toBe("#1f1f1f");
    expect(lightOverlay.height).toBe(36);
    expect(darkOverlay.symbolColor).toBe("#ffffff");
    expect(darkOverlay.height).toBe(54);
  });

  test("selects platform-specific titlebar options", () => {
    const macOptions = resolveCodexTitleBarOptions({ platform: "darwin" });
    const windowsOptions = resolveCodexTitleBarOptions({ platform: "win32", isDark: true });
    const linuxOptions = resolveCodexTitleBarOptions({ platform: "linux" });

    expect(macOptions.titleBarStyle).toBe("hiddenInset");
    expect(windowsOptions.titleBarStyle).toBe("hidden");
    expect(linuxOptions.titleBarStyle).toBe("default");
  });
});
