import { describe, expect, test } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { workbenchMainSurfaceClassName } from "@/components/workbench/workbench-route-host";

import "@/globals.css";

installRendererThemeFixture();

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

const mountRole = (className: string): HTMLDivElement => {
  const element = document.createElement("div");
  element.className = className;
  document.body.append(element);
  return element;
};

const setWindowTheme = (windowType: "browser" | "electron", scheme: "light" | "dark") => {
  applyRendererThemeForTest(scheme, { windowType });
};

describe("semantic theme contract in the renderer build", () => {
  test("resolves semantic text and status roles from their canonical variables", () => {
    document.body.style.setProperty("--color-text-danger", "rgb(201, 32, 18)");
    document.body.style.setProperty("--color-text-info", "rgb(18, 105, 201)");
    document.body.style.setProperty("--color-text-tertiary", "rgb(101, 102, 103)");
    document.body.style.setProperty("--color-text-secondary", "rgb(71, 72, 73)");

    expect(getComputedStyle(mountRole("text-danger")).color).toBe("rgb(201, 32, 18)");
    expect(getComputedStyle(mountRole("text-info")).color).toBe("rgb(18, 105, 201)");
    expect(getComputedStyle(mountRole("text-tertiary")).color).toBe("rgb(101, 102, 103)");
    expect(getComputedStyle(mountRole("semantic-text-secondary")).color).toBe("rgb(71, 72, 73)");
  });

  test("keeps the semantic secondary role independent from the generic control color", () => {
    document.body.style.setProperty("--color-secondary", "rgb(220, 10, 10)");
    document.body.style.setProperty("--color-text-secondary", "rgb(10, 120, 40)");

    expect(getComputedStyle(mountRole("semantic-text-secondary")).color).toBe("rgb(10, 120, 40)");
    expect(getComputedStyle(mountRole("text-secondary")).color).not.toBe("rgb(10, 120, 40)");
  });

  test.each([
    { windowType: "electron", scheme: "light" },
    { windowType: "electron", scheme: "dark" },
    { windowType: "browser", scheme: "light" },
    { windowType: "browser", scheme: "dark" },
  ] as const)(
    "preserves the secondary text alpha through the $windowType $scheme theme cascade",
    ({ windowType, scheme }) => {
      setWindowTheme(windowType, scheme);
      const foreground = getComputedStyle(document.documentElement).getPropertyValue(
        "--app-color-text-foreground",
      );
      const secondary = mountRole("semantic-text-secondary");
      const expected = mountRole("");
      expected.style.color = `color-mix(in srgb, ${foreground} 65%, transparent)`;
      expect(getComputedStyle(secondary).color).toBe(getComputedStyle(expected).color);

      document.documentElement.style.setProperty(
        "--app-color-text-secondary",
        "rgb(20 40 60 / 0.4)",
      );
      expect(getComputedStyle(secondary).color).toBe("rgba(20, 40, 60, 0.4)");
    },
  );

  test("resolves semantic border and progress roles", () => {
    document.body.style.setProperty("--color-border", "rgb(42, 43, 44)");
    document.body.style.setProperty("--color-text", "rgb(18, 105, 201)");
    document.body.style.setProperty("--color-text-info", "rgb(18, 105, 201)");
    const border = mountRole("border border-default");
    const fill = mountRole("bg-text-info");
    const track = mountRole("bg-text/10");

    expect(getComputedStyle(border).borderTopColor).toBe("rgb(42, 43, 44)");
    expect(getComputedStyle(fill).backgroundColor).toBe("rgb(18, 105, 201)");
    expect(getComputedStyle(track).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("keeps production radii and electron layout dimensions resolvable", () => {
    setWindowTheme("electron", "light");
    const rounded = mountRole("rounded-lg");
    const sidebarWidth = mountRole("w-token-sidebar");

    expect(Number.parseFloat(getComputedStyle(rounded).borderTopLeftRadius)).toBeGreaterThan(0);
    expect(Number.parseFloat(getComputedStyle(sidebarWidth).width)).toBeGreaterThanOrEqual(240);
    const rootStyle = getComputedStyle(document.documentElement);
    expect(rootStyle.getPropertyValue("--spacing-token-sidebar")).toContain("300px");
    expect(rootStyle.getPropertyValue("--height-toolbar").trim()).toBe("46px");
  });

  test("keeps the browser toolbar override independent from the electron default", () => {
    setWindowTheme("browser", "light");

    expect(
      getComputedStyle(document.documentElement).getPropertyValue("--height-toolbar").trim(),
    ).toBe("56px");
  });

  test("resolves both icon dimensions and heading sizes through the extracted utility cascade", () => {
    setWindowTheme("electron", "light");
    for (const [className, size] of [
      ["icon-xxs", "12px"],
      ["icon-2xs", "14px"],
      ["icon-xs", "16px"],
      ["icon-sm", "18px"],
      ["icon-base", "20px"],
    ]) {
      const style = getComputedStyle(mountRole(className));
      expect(style.width, className).toBe(size);
      expect(style.height, className).toBe(size);
    }
    expect(getComputedStyle(mountRole("heading-lg")).fontSize).toBe("24px");
  });

  test("uses the dark primary foreground without weakening secondary text roles", () => {
    setWindowTheme("electron", "dark");
    const rootStyle = getComputedStyle(document.documentElement);

    expect(rootStyle.getPropertyValue("--app-color-text-foreground").trim()).toBe("#fcfcfc");
    expect(getComputedStyle(mountRole("text-token-foreground")).color).toBe("rgb(252, 252, 252)");
    expect(rootStyle.getPropertyValue("--app-color-text-foreground-secondary").trim()).toBe(
      "rgba(252, 252, 252, 0.71)",
    );
    expect(rootStyle.getPropertyValue("--app-color-text-foreground-tertiary").trim()).toBe(
      "rgba(252, 252, 252, 0.498)",
    );
  });

  test.each([
    {
      outer: "light",
      inner: "dark",
      danger: "rgb(255, 103, 100)",
      surface: "rgb(24, 24, 24)",
    },
    {
      outer: "dark",
      inner: "light",
      danger: "rgb(224, 46, 42)",
      surface: "rgb(255, 255, 255)",
    },
  ] as const)(
    "resolves an $inner inspection surface inside an $outer window",
    ({ outer, inner, danger, surface }) => {
      setWindowTheme("electron", outer);
      const inspection = mountRole("");
      inspection.dataset.theme = inner;
      const status = mountRole("text-danger bg-surface");
      inspection.append(status);

      expect(getComputedStyle(status).color).toBe(danger);
      expect(getComputedStyle(status).backgroundColor).toBe(surface);
    },
  );

  test("keeps main content, legacy content, and conversation roles aligned across theme changes", () => {
    // The one opaque content surface every route renders inside.
    const main = mountRole(`${workbenchMainSurfaceClassName(false)} text-token-foreground`);
    const legacy = mountRole("bg-background text-foreground");
    const bubble = mountRole("bg-user-message text-user-message");
    const composer = mountRole("bg-composer-primary text-composer-primary");

    for (const scheme of ["dark", "light", "dark"] as const) {
      setWindowTheme("electron", scheme);
      const isDark = scheme === "dark";
      const surface = isDark ? "rgb(17, 17, 17)" : "rgb(255, 255, 255)";
      const ink = isDark ? "rgb(252, 252, 252)" : "rgb(13, 13, 13)";

      expect(getComputedStyle(main).backgroundColor).toBe(surface);
      expect(getComputedStyle(main).color).toBe(ink);
      expect(getComputedStyle(legacy).backgroundColor).toBe(surface);
      expect(getComputedStyle(legacy).color).toBe(ink);
      expect(getComputedStyle(bubble).backgroundColor).toBe(
        readRendererThemeColor("--color-background-user-message"),
      );
      expect(getComputedStyle(bubble).color).toBe(
        readRendererThemeColor("--color-text-user-message"),
      );
      expect(getComputedStyle(composer).backgroundColor).toBe(
        readRendererThemeColor("--color-background-composer-primary"),
      );
      expect(getComputedStyle(composer).color).toBe(
        readRendererThemeColor("--color-text-composer-primary"),
      );
    }
  });

  test("resolves production shimmer and sidebar surfaces in both electron schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      setWindowTheme("electron", scheme);
      const shimmer = mountRole("loading-shimmer-pure-text");
      const sidebar = mountRole("app-shell-left-panel");
      const shimmerStyle = getComputedStyle(shimmer);
      const sidebarStyle = getComputedStyle(sidebar);

      expect(shimmerStyle.backgroundImage).not.toBe("none");
      expect(shimmerStyle.webkitTextFillColor).toBe("rgba(0, 0, 0, 0)");
      expect(
        sidebarStyle.backgroundColor,
        JSON.stringify({
          token: sidebarStyle.getPropertyValue("--color-token-editor-background"),
          vscode: sidebarStyle.getPropertyValue("--vscode-editor-background"),
          surface: sidebarStyle.getPropertyValue("--color-surface-tertiary"),
        }),
      ).not.toBe("rgba(0, 0, 0, 0)");
      shimmer.remove();
      sidebar.remove();
    }
  });

  test("keeps search matches visible and distinguishes the active match in both schemes", () => {
    const match = document.createElement("mark");
    match.className = "codex-thread-find-match";
    const active = document.createElement("mark");
    active.className = "codex-thread-find-match codex-thread-find-active";
    document.body.append(match, active);

    for (const scheme of ["light", "dark"] as const) {
      setWindowTheme("electron", scheme);
      const matchBackground = getComputedStyle(match).backgroundColor;
      const activeBackground = getComputedStyle(active).backgroundColor;

      expect(matchBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(activeBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(activeBackground).not.toBe(matchBackground);
    }
  });

  test("keeps production shimmer visible but static under reduced motion", async () => {
    const session = cdp() as unknown as ChromiumMediaEmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      setWindowTheme("electron", "dark");
      const shimmerStyle = getComputedStyle(mountRole("loading-shimmer-pure-text"));

      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(shimmerStyle.animationName).toBe("none");
      expect(shimmerStyle.backgroundImage).not.toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });
});
