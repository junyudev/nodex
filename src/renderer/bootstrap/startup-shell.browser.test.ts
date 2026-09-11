import { afterEach, describe, expect, test } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import {
  createStartupShellCriticalCss,
  createStartupShellMarkup,
} from "../../../config/startup-shell-html";

interface ChromiumMediaEmulationSession {
  send(
    method: "Emulation.setEmulatedMedia",
    params: {
      features: Array<{
        name: "prefers-reduced-motion";
        value: "no-preference" | "reduce";
      }>;
    },
  ): Promise<unknown>;
}

function mountStartupShell(input: { readonly dark: boolean; readonly opaque: boolean }) {
  const style = document.createElement("style");
  style.dataset.startupShellTest = "true";
  style.textContent = createStartupShellCriticalCss();
  document.head.append(style);
  document.documentElement.classList.toggle("dark", input.dark);
  document.documentElement.classList.toggle("electron-opaque", input.opaque);
  document.body.innerHTML = `<div id="root">${createStartupShellMarkup()}</div>`;

  const logo = document.querySelector<SVGElement>(".nodex-startup-logo-base");
  const highlight = document.querySelector<HTMLElement>(".nodex-startup-logo-highlight");
  const shimmer = document.querySelector<HTMLElement>(".nodex-startup-logo-highlight > span");
  if (!logo || !highlight || !shimmer) throw new Error("Startup shell fixture is incomplete");
  return { highlight, logo, shimmer };
}

afterEach(() => {
  document.head.querySelector("[data-startup-shell-test]")?.remove();
  document.documentElement.classList.remove("dark", "electron-opaque");
});

describe("parser-time startup shell presentation", () => {
  test("keeps the base logo visible in light and dark transparent surfaces", () => {
    const light = mountStartupShell({ dark: false, opaque: false });
    const lightColor = getComputedStyle(light.logo).color;
    expect(lightColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    document.body.replaceChildren();
    document.head.querySelector("[data-startup-shell-test]")?.remove();
    const dark = mountStartupShell({ dark: true, opaque: false });
    const darkColor = getComputedStyle(dark.logo).color;
    expect(darkColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(darkColor).not.toBe(lightColor);
  });

  test.each([
    { dark: false, expected: "rgb(245, 245, 245)" },
    { dark: true, expected: "rgb(14, 14, 14)" },
  ])(
    "uses the shared theme surface before application scripts load: dark=$dark",
    ({ dark, expected }) => {
      mountStartupShell({ dark, opaque: true });
      expect(getComputedStyle(document.body).backgroundColor).toBe(expected);
    },
  );

  test("removes the only startup animation under reduced motion", async () => {
    const session = cdp() as unknown as ChromiumMediaEmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      const { highlight, logo } = mountStartupShell({ dark: false, opaque: false });
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(getComputedStyle(highlight).display).toBe("none");
      expect(document.getAnimations()).toHaveLength(0);
      expect(getComputedStyle(logo).display).toBe("block");
      expect(getComputedStyle(logo).color).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });
});
