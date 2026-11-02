import { describe, expect, test } from "vite-plus/test";
import {
  formatWindowsMenuAccelerator,
  resolveApplicationMenubarKey,
} from "./application-menubar-keyboard";
const idle = { altPending: false, focused: false, open: false };
const key = (key: string, input: Partial<KeyboardEvent> = {}) => ({
  key,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...input,
});

describe("Windows menu keyboard ownership", () => {
  test("Alt alone toggles on release, while a chord cancels its pending toggle", () => {
    expect(resolveApplicationMenubarKey(key("Alt"), idle, "down")).toBe("alt");
    expect(resolveApplicationMenubarKey(key("Alt"), { ...idle, altPending: true }, "up")).toBe(
      "toggle",
    );
    expect(
      resolveApplicationMenubarKey(
        key("Tab", { altKey: true }),
        { ...idle, altPending: true },
        "down",
      ),
    ).toBe("cancel-alt");
    expect(resolveApplicationMenubarKey(key("Alt"), idle, "up")).toBeNull();
  });
  test("mnemonics belong to Alt or focused menubar mode", () => {
    expect(resolveApplicationMenubarKey(key("f", { altKey: true }), idle, "down")).toEqual({
      mnemonic: "f",
    });
    expect(resolveApplicationMenubarKey(key("e"), { ...idle, focused: true }, "down")).toEqual({
      mnemonic: "e",
    });
    expect(
      resolveApplicationMenubarKey(key("e"), { ...idle, focused: true, open: true }, "down"),
    ).toBeNull();
    expect(resolveApplicationMenubarKey(key("f"), idle, "down")).toBeNull();
  });
  test("does not claim repeated, composed, or modified F10", () => {
    expect(resolveApplicationMenubarKey(key("F10"), idle, "down")).toBe("toggle");
    for (const input of [
      { repeat: true },
      { isComposing: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      expect(resolveApplicationMenubarKey(key("F10", input), idle, "down")).toBeNull();
    }
    expect(resolveApplicationMenubarKey(key("Escape"), { ...idle, open: true }, "down")).toBe(
      "close",
    );
  });
  test.each([
    ["Shift+Control+Alt+Super+F", "Win+Alt+Ctrl+Shift+F"],
    ["CommandOrControl+Plus", "Ctrl+Shift+="],
    ["Command+Meta+Ctrl+-", "Win+Ctrl+-"],
    ["Alt+F4", "Alt+F4"],
  ])("formats %s for native menu presentation", (input, output) =>
    expect(formatWindowsMenuAccelerator(input)).toBe(output),
  );
});
