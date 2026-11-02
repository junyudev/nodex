import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { openNodexMenu, render, settleAsyncRender } from "@/test/dom";
import type { LinkOpeningSettings } from "../../../shared/link-opening-settings";
import {
  ExternalBrowserLinkShortcutSettingRow,
  LinkDestinationSettingRows,
} from "./link-opening-settings-controls";

const state = vi.hoisted(() => ({
  settings: {
    openLinkInTarget: "external-browser",
    openLocalUrlInTarget: "in-app-browser",
    externalBrowserLinkShortcut: "primary",
  } as LinkOpeningSettings,
  updateSettings: vi.fn(async (next: LinkOpeningSettings) => next),
}));

vi.mock("@/lib/link-opening-settings", () => ({
  useLinkOpeningSettings: () => ({
    settings: state.settings,
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings: state.updateSettings,
  }),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

function setPlatform(value: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, value });
}

beforeEach(() => {
  state.updateSettings.mockClear();
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
});

describe("link destination settings", () => {
  test("show each destination and save a change without touching the other settings", async () => {
    const view = render(<LinkDestinationSettingRows />);
    expect(
      view.getByRole("button", { name: "Web URL and link open destination: Default browser" }),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Local URL open destination: Nodex" })).toBeTruthy();

    await openNodexMenu(
      view.getByRole("button", { name: "Web URL and link open destination: Default browser" }),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Nodex" }));
      await settleAsyncRender();
    });
    expect(state.updateSettings).toHaveBeenCalledWith({
      openLinkInTarget: "in-app-browser",
      openLocalUrlInTarget: "in-app-browser",
      externalBrowserLinkShortcut: "primary",
    });
  });

  test("choosing the current destination saves nothing", async () => {
    const view = render(<LinkDestinationSettingRows />);
    await openNodexMenu(view.getByRole("button", { name: "Local URL open destination: Nodex" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Nodex" }));
      await settleAsyncRender();
    });
    expect(state.updateSettings).not.toHaveBeenCalled();
  });
});

describe("external browser link shortcut", () => {
  test("names the modifiers for macOS and saves the chosen shortcut", async () => {
    setPlatform("MacIntel");
    const view = render(<ExternalBrowserLinkShortcutSettingRow />);
    const trigger = view.getByRole("button", { name: "Open web link in default browser: ⌘+Click" });
    await openNodexMenu(trigger);
    expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Unassigned",
      "⌘+Click",
      "⌥+Click",
      "⇧⌘+Click",
    ]);
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Unassigned" }));
      await settleAsyncRender();
    });
    expect(state.updateSettings).toHaveBeenCalledWith({
      ...state.settings,
      externalBrowserLinkShortcut: "unassigned",
    });
  });

  test("names Ctrl and Alt on other platforms", async () => {
    setPlatform("Win32");
    const view = render(<ExternalBrowserLinkShortcutSettingRow />);
    await openNodexMenu(
      view.getByRole("button", { name: "Open web link in default browser: Ctrl+Click" }),
    );
    expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Unassigned",
      "Ctrl+Click",
      "Alt+Click",
      "Ctrl+Shift+Click",
    ]);
  });
});
