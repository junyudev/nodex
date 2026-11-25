import { afterEach, describe, expect, test } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import { applyRendererThemeForTest, readRendererThemeColor } from "@/test/renderer-theme";
import {
  createStartupShellCriticalCss,
  createStartupShellMarkup,
} from "../../../config/startup-shell-html";
import {
  TYPOGRAPHY_STORAGE_KEY,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  applyTypographyPreferences,
} from "../lib/typography-preferences";

describe("startup shell", () => {
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
});

describe("typography bootstrap", () => {
  let frame: HTMLIFrameElement | null = null;
  afterEach(() => {
    frame?.remove();
    frame = null;
    localStorage.removeItem(TYPOGRAPHY_STORAGE_KEY);
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  async function loadParserBootstrapDocument(): Promise<Document> {
    frame = document.createElement("iframe");
    const loaded = new Promise<void>((resolve) =>
      frame!.addEventListener("load", () => resolve(), { once: true }),
    );
    frame.srcdoc = `<html data-theme="dark"><head><script src="${location.origin}/typography-bootstrap.js"></script><script>
    document.documentElement.dataset.parserBodyPresent = String(document.body !== null);
    document.documentElement.dataset.parserFontSmoothing = getComputedStyle(document.documentElement).getPropertyValue("-webkit-font-smoothing");
  </script><style>
    #ui { font: var(--font-ui-size)/1.5 var(--font-ui-family); }
    #chat { font: var(--codex-chat-font-size)/1.5 var(--font-content); }
    #code { font: var(--codex-chat-code-font-size)/1.5 var(--font-mono); }
    #page { font: var(--text-document)/1.5 var(--font-content); }
  </style></head><body><p id="ui">UI</p><p id="chat">Chat</p><pre id="code">Code</pre><p id="page">Page</p></body></html>`;
    document.body.append(frame);
    await loaded;
    return frame.contentDocument!;
  }

  test.each(["inherit", "Arial,"])(
    "invalid font family %s retains system and monospace fallbacks",
    (family) => {
      applyTypographyPreferences(
        document.documentElement,
        document.body,
        {
          ...DEFAULT_TYPOGRAPHY_PREFERENCES,
          fonts: {
            ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
            light: { ui: family, content: family, code: family },
          },
        },
        "light",
      );
      const ui = document.createElement("span");
      const code = document.createElement("code");
      ui.style.fontFamily = "var(--font-sans)";
      code.style.fontFamily = "var(--font-code-family)";
      document.body.append(ui, code);
      try {
        expect(getComputedStyle(ui).fontFamily).toContain("-apple-system");
        expect(getComputedStyle(code).fontFamily).toContain("monospace");
      } finally {
        ui.remove();
        code.remove();
      }
    },
  );

  test("restores saved typography with only the parser bootstrap and no application modules", async () => {
    localStorage.setItem(
      TYPOGRAPHY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_TYPOGRAPHY_PREFERENCES,
        uiFontSize: 16,
        codeFontSize: 20,
        pageFontSize: 18,
        useFontSmoothing: false,
        fonts: {
          ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
          dark: { ui: "Arial", content: "Georgia", code: "Monaco" },
        },
      }),
    );
    const doc = await loadParserBootstrapDocument();
    const view = doc.defaultView!;
    const style = (id: string) => view.getComputedStyle(doc.getElementById(id)!);
    expect(style("ui").fontSize).toBe("16px");
    expect(style("chat").fontSize).toBe("16px");
    expect(style("code").fontSize).toBe("20px");
    expect(style("page").fontSize).toBe("18px");
    expect(style("ui").fontFamily).toContain("Arial");
    expect(style("chat").fontFamily).toContain("Georgia");
    expect(doc.documentElement.style.getPropertyValue("--font-ui-size")).toBe("16px");
    expect(doc.body.style.getPropertyValue("--font-ui-size")).toBe("16px");
    expect(doc.documentElement.dataset.parserBodyPresent).toBe("false");
    expect(doc.documentElement.dataset.parserFontSmoothing).toBe("auto");
    expect(doc.documentElement.style.getPropertyValue("-webkit-font-smoothing")).toBe("auto");
    expect(doc.body.style.getPropertyValue("-webkit-font-smoothing")).toBe("auto");
    expect(style("page").getPropertyValue("-webkit-font-smoothing")).toBe("auto");
  });

  test.each(["missing", "existing"])(
    "%s typography preferences enable font smoothing before application modules load",
    async (storage) => {
      if (storage === "existing") {
        localStorage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify({ uiFontSize: 16 }));
      }
      const doc = await loadParserBootstrapDocument();
      expect(doc.documentElement.dataset.parserBodyPresent).toBe("false");
      expect(doc.documentElement.dataset.parserFontSmoothing).toBe("antialiased");
      expect(doc.documentElement.style.getPropertyValue("-webkit-font-smoothing")).toBe(
        "antialiased",
      );
      expect(doc.body.style.getPropertyValue("-webkit-font-smoothing")).toBe("antialiased");
      expect(
        doc
          .defaultView!.getComputedStyle(doc.getElementById("page")!)
          .getPropertyValue("-webkit-font-smoothing"),
      ).toBe("antialiased");
    },
  );
});
