import { describe, expect, it } from "vitest";
import { createAvatarOverlayWindowOptions, withAvatarOverlayRoute } from "./AvatarOverlayRuntime";

describe("AvatarOverlayRuntime window boundary", () => {
  it("uses the restricted avatar route", () => {
    const url = new URL(withAvatarOverlayRoute("app://-/index.html?theme=dark"));
    expect(url.searchParams.get("initialRoute")).toBe("/avatar-overlay");
    expect(url.searchParams.get("theme")).toBe("dark");
  });

  it("creates a transparent non-restorable panel with a narrow preload", () => {
    const options = createAvatarOverlayWindowOptions("/tmp/avatar-overlay.js", "darwin");
    expect(options).toMatchObject({
      focusable: false,
      frame: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      type: "panel",
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: "/tmp/avatar-overlay.js",
        sandbox: true,
      },
    });
  });
});
