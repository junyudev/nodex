import { afterEach, describe, expect, test } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import { applyRendererThemeForTest, readRendererThemeColor } from "@/test/renderer-theme";
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
  document.body.innerHTML = `${createStartupShellMarkup()}<div id="root"></div>`;

  const brand = document.querySelector<HTMLElement>(".nodex-startup-brand");
  const logo = document.querySelector<SVGElement>(".nodex-startup-logo-base");
  const highlight = document.querySelector<HTMLElement>(".nodex-startup-logo-highlight");
  const shimmer = document.querySelector<HTMLElement>(".nodex-startup-logo-highlight > span");
  const visibleStatus = document.querySelector<HTMLElement>("[data-startup-visible-status]");
  if (!brand || !logo || !highlight || !shimmer || !visibleStatus) {
    throw new Error("Startup shell fixture is incomplete");
  }
  return { brand, highlight, logo, shimmer, visibleStatus };
}

function readColorAlpha(color: string): number {
  const channels = color
    .match(/^rgba?\((.+)\)$/u)?.[1]
    ?.split(/[\s,/]+/u)
    .filter(Boolean);
  if (!channels || channels.length < 3) throw new Error(`Unsupported computed color: ${color}`);
  return channels.length === 3 ? 1 : Number(channels[3]);
}

function readCenter(element: Element): { readonly x: number; readonly y: number } {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

afterEach(() => {
  document.head.querySelector("[data-startup-shell-test]")?.remove();
  document.head.querySelector("style[data-codex-app-themes]")?.remove();
  const root = document.documentElement;
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  root.removeAttribute("data-codex-window-type");
  root.classList.remove("dark", "electron-opaque", "electron-dark", "electron-light");
});

describe("parser-time startup shell presentation", () => {
  test("renders the base logo as a visible translucent material in light and dark", () => {
    const light = mountStartupShell({ dark: false, opaque: false });
    const lightColor = getComputedStyle(light.logo).color;
    expect(readColorAlpha(lightColor)).toBeGreaterThan(0);
    expect(readColorAlpha(lightColor)).toBeLessThan(1);
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    document.body.replaceChildren();
    document.head.querySelector("[data-startup-shell-test]")?.remove();
    const dark = mountStartupShell({ dark: true, opaque: false });
    const darkColor = getComputedStyle(dark.logo).color;
    expect(readColorAlpha(darkColor)).toBeGreaterThan(0);
    expect(readColorAlpha(darkColor)).toBeLessThan(1);
    expect(darkColor).not.toBe(lightColor);
  });

  test("keeps the mark centered when migration status copy appears", () => {
    const { brand, visibleStatus } = mountStartupShell({ dark: false, opaque: false });
    const viewportCenter = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const quietCenter = readCenter(brand);

    visibleStatus.textContent = "Updating local data… 42%";
    visibleStatus.hidden = false;
    const statusCenter = readCenter(brand);

    expect(quietCenter.x).toBeCloseTo(viewportCenter.x, 0);
    expect(quietCenter.y).toBeCloseTo(viewportCenter.y, 0);
    expect(statusCenter).toEqual(quietCenter);
    expect(visibleStatus.getBoundingClientRect().top).toBeGreaterThan(
      brand.getBoundingClientRect().bottom,
    );
  });

  test.each([{ dark: false }, { dark: true }])(
    "uses the shared theme surface before application scripts load: dark=$dark",
    ({ dark }) => {
      mountStartupShell({ dark, opaque: true });
      const startupSurface = getComputedStyle(document.body).backgroundColor;

      const variant = dark ? "dark" : "light";
      applyRendererThemeForTest(variant, {
        accents: { [variant]: { kind: "custom", color: "#df5142" } },
      });
      expect(startupSurface).toBe(readRendererThemeColor("--app-color-background-surface-under"));
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--codex-base-accent"),
      ).toBe("#df5142");
    },
  );

  test("lays the application out unseen beneath the shell, and shows it once revealed", async () => {
    mountStartupShell({ dark: false, opaque: true });
    const root = document.getElementById("root")!;
    const shell = document.querySelector<HTMLElement>(".nodex-startup-shell")!;
    root.innerHTML = '<button type="button">Workbench</button>';
    const button = root.querySelector("button")!;

    expect(getComputedStyle(root).opacity).toBe("0");
    const bounds = button.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(0);
    // Pointer input reaches the shell, never the application it holds.
    const hit = () =>
      document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    expect(shell.contains(hit())).toBe(true);
    // Keyboard focus still reaches the application, so typing ahead is kept.
    button.focus();
    expect(document.activeElement).toBe(button);

    shell.dataset.startupRevealing = "";
    expect(getComputedStyle(shell).pointerEvents).toBe("none");
    const handoff = document
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition);
    expect(handoff).toHaveLength(2);
    await Promise.all(handoff.map((animation) => animation.finished));
    expect(getComputedStyle(root).opacity).toBe("1");
    expect(getComputedStyle(shell).opacity).toBe("0");

    expect(hit()).toBe(button);

    shell.remove();
    expect(getComputedStyle(root).opacity).toBe("1");
    expect(hit()).toBe(button);
  });

  test("never hides the application of a compact window", () => {
    mountStartupShell({ dark: false, opaque: true });
    document.documentElement.classList.add("hide-startup-shell");
    try {
      expect(getComputedStyle(document.getElementById("root")!).opacity).toBe("1");
    } finally {
      document.documentElement.classList.remove("hide-startup-shell");
    }
  });

  test("shows a static mark without startup motion under reduced motion", async () => {
    const session = cdp() as unknown as ChromiumMediaEmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      const { brand, highlight, logo } = mountStartupShell({ dark: false, opaque: false });
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(getComputedStyle(highlight).display).toBe("none");
      expect(document.getAnimations()).toHaveLength(0);
      expect(getComputedStyle(brand).opacity).toBe("1");
      expect(getComputedStyle(logo).display).toBe("block");
      expect(getComputedStyle(logo).color).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });
});
