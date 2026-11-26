import { act, render } from "@testing-library/react";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, test } from "vite-plus/test";
import "@/globals.css";
import { installRendererThemeFixture, readRendererThemeColor } from "@/test/renderer-theme";
import {
  applyTypographyPreferences,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
} from "@/lib/typography-preferences";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFrame,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexThemeModeSelector } from "@/components/ui/theme-mode-selector";
import { NodexSettingsPageSurface, NodexSettingsRow } from "@/components/ui/settings";

installRendererThemeFixture();
afterEach(() =>
  document.querySelectorAll("[data-typography-probe]").forEach((node) => node.remove()),
);

function probe(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.dataset.typographyProbe = "";
  element.className = className;
  element.textContent = "Typography";
  document.body.append(element);
  return element;
}

function typography(element: Element) {
  const style = getComputedStyle(element);
  return {
    size: Number.parseFloat(style.fontSize),
    line: Number.parseFloat(style.lineHeight),
    family: style.fontFamily,
    weight: style.fontWeight,
  };
}

describe("workspace typography cascade", () => {
  test("resolves a fresh document's defaults before a React provider writes preferences", () => {
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue("--codex-chat-font-size").trim()).toBe("14px");
    expect(root.getPropertyValue("--codex-chat-code-font-size").trim()).toBe("12px");
    expect(typography(probe("text-size-chat leading-relaxed"))).toMatchObject({
      size: 14,
      line: 22.75,
      weight: "430",
    });
    expect(typography(probe("font-code text-size-code"))).toMatchObject({ size: 12 });
    expect(typography(probe("text-sm"))).toMatchObject({ size: 13 });
    expect(typography(probe("text-xs"))).toMatchObject({ size: 12 });
  });

  test("shares font smoothing across UI and Markdown while preserving semantic weights", () => {
    const surfaces = [
      probe("text-base"),
      probe("codex-markdown"),
      probe("font-normal"),
      probe("font-medium"),
      probe("font-semibold"),
    ];
    for (const useFontSmoothing of [true, false]) {
      applyTypographyPreferences(
        document.documentElement,
        document.body,
        { ...DEFAULT_TYPOGRAPHY_PREFERENCES, useFontSmoothing },
        "light",
      );
      for (const surface of surfaces) {
        expect(getComputedStyle(surface).getPropertyValue("-webkit-font-smoothing")).toBe(
          useFontSmoothing ? "antialiased" : "auto",
        );
      }
      expect(surfaces.map((surface) => typography(surface).weight)).toEqual([
        "430",
        "430",
        "400",
        "500",
        "600",
      ]);
    }
  });

  test("settings and dialogs inherit the selected UI scale without local overrides", async () => {
    const preferences = {
      ...DEFAULT_TYPOGRAPHY_PREFERENCES,
      fonts: {
        ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
        light: { ui: "Arial", content: "Georgia", code: "monospace" },
      },
    };
    applyTypographyPreferences(document.documentElement, document.body, preferences, "light");
    const settings = render(
      <NodexSettingsPageSurface title="Appearance">
        <NodexSettingsRow label="UI font size" description="Shared UI text">
          <button type="button">Choose size</button>
        </NodexSettingsRow>
      </NodexSettingsPageSurface>,
    );
    const heading = settings.getByRole("heading", { name: "Appearance" });
    const label = settings.getByText("UI font size");
    expect(typography(heading)).toMatchObject({ size: 28, line: 33.6, weight: "500" });
    expect(typography(label)).toMatchObject({ size: 13, weight: "500" });
    expect(typography(label).family).toContain("Arial");

    const dialog = render(
      <NodexDialog open onOpenChange={() => undefined}>
        <NodexDialogContent initialFocus={false}>
          <NodexDialogFrame>
            <NodexDialogTitle>Rename chat</NodexDialogTitle>
            <NodexDialogDescription>Choose a title</NodexDialogDescription>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>,
    );
    const title = await dialog.findByRole("heading", { name: "Rename chat" });
    const description = dialog.getByText("Choose a title");
    expect(typography(title)).toMatchObject({ size: 20, line: 28, weight: "600" });
    expect(typography(description)).toMatchObject({ size: 14, line: 21 });
    expect(typography(title).family).toContain("Arial");

    await act(async () => {
      applyTypographyPreferences(
        document.documentElement,
        document.body,
        { ...preferences, uiFontSize: 16, codeFontSize: 20, pageFontSize: 18 },
        "light",
      );
      await Promise.resolve();
    });
    expect(typography(heading)).toMatchObject({ size: 32, line: 38.4 });
    expect(typography(label).size).toBe(15);
    expect(typography(title)).toMatchObject({ size: 23, line: 28 });
    expect(typography(description)).toMatchObject({ size: 16, line: 24 });
    expect(title.isConnected).toBe(true);
    expect(getComputedStyle(document.body).getPropertyValue("--text-document").trim()).toBe("18px");
    expect(
      getComputedStyle(document.documentElement).getPropertyValue("--font-code-size").trim(),
    ).toBe("20px");
  });
});

test("Appearance mode previews preserve their size, selection and keyboard focus", async () => {
  const view = render(<NodexThemeModeSelector value="system" onValueChange={() => undefined} />);
  const group = view.getByRole("radiogroup", { name: "Mode" });
  const system = view.getByRole("radio", { name: "System" });
  const light = view.getByRole("radio", { name: "Light" });
  const systemPreview = system.nextElementSibling;
  const lightPreview = light.nextElementSibling;
  const systemRing = systemPreview?.lastElementChild;
  const lightRing = lightPreview?.lastElementChild;
  if (!systemPreview || !lightPreview || !systemRing || !lightRing) {
    throw new Error("Appearance mode previews are missing");
  }
  expect(group.getBoundingClientRect().width).toBe(272);
  expect(getComputedStyle(group).columnGap).toBe("16px");
  expect(systemPreview.getBoundingClientRect()).toMatchObject({ width: 80, height: 60 });
  expect(getComputedStyle(systemPreview).borderRadius).toBe("10px");
  expect(getComputedStyle(systemRing).borderTopWidth).toBe("2px");
  expect(getComputedStyle(systemRing).borderTopColor).toBe(readRendererThemeColor("--color-ring"));
  expect(getComputedStyle(lightRing).borderTopWidth).toBe("1px");
  expect(getComputedStyle(lightRing).borderTopColor).toBe(readRendererThemeColor("--color-border"));

  await act(async () => userEvent.keyboard("{Tab}"));
  expect(document.activeElement).toBe(system);
  expect(getComputedStyle(systemPreview).outlineWidth).toBe("2px");
  expect(getComputedStyle(systemPreview).outlineOffset).toBe("2px");
  expect(getComputedStyle(systemPreview).outlineColor).toBe(readRendererThemeColor("--color-ring"));
  expect(await view.findByRole("tooltip", { name: "System" })).toBeVisible();

  await act(async () => userEvent.keyboard("{Escape}"));
  await act(async () => userEvent.hover(lightPreview));
  expect(getComputedStyle(lightRing).borderTopColor).toBe(
    readRendererThemeColor("--color-border-strong"),
  );
  expect(await view.findByRole("tooltip", { name: "Light" })).toBeVisible();
});
