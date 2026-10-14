import { describe, expect, test } from "vite-plus/test";
import {
  decodeAccentColorPreferences,
  resolveAccentColorPreference,
  updateAccentColorPreference,
} from "./theme-preferences";

describe("accent color preferences", () => {
  test("validates persisted presets and independent custom colors", () => {
    expect(
      decodeAccentColorPreferences({ preset: "green", light: " #AABBCC ", dark: "#123" }),
    ).toEqual({
      light: { kind: "custom", color: "#aabbcc" },
      dark: { kind: "preset", name: "green" },
    });
    expect(
      decodeAccentColorPreferences({ preset: "unrecognized", light: "red", dark: 42 }),
    ).toEqual({
      light: { kind: "preset", name: "default" },
      dark: { kind: "preset", name: "default" },
    });
    expect(decodeAccentColorPreferences(null)).toEqual({
      light: { kind: "preset", name: "default" },
      dark: { kind: "preset", name: "default" },
    });
  });

  test("custom colors are saved only for the appearance being edited", () => {
    const base = decodeAccentColorPreferences({ preset: "purple" });
    const light = updateAccentColorPreference(base, "light", { kind: "custom", color: "#ABCDEF" });
    const both = updateAccentColorPreference(light, "dark", { kind: "custom", color: "#123456" });

    expect(resolveAccentColorPreference(light, "light")).toEqual({
      kind: "custom",
      color: "#abcdef",
    });
    expect(resolveAccentColorPreference(light, "dark")).toEqual({ kind: "preset", name: "purple" });
    expect(resolveAccentColorPreference(both, "dark")).toEqual({
      kind: "custom",
      color: "#123456",
    });
    expect(resolveAccentColorPreference(both, "light")).toEqual({
      kind: "custom",
      color: "#abcdef",
    });
  });

  test("changing a preset preserves every choice in the other appearance", () => {
    const preferences = decodeAccentColorPreferences({
      preset: "blue",
      light: "#112233",
      dark: "#445566",
    });
    const next = updateAccentColorPreference(preferences, "light", {
      kind: "preset",
      name: "yellow",
    });

    expect(resolveAccentColorPreference(next, "light")).toEqual({ kind: "preset", name: "yellow" });
    expect(resolveAccentColorPreference(next, "dark")).toEqual({
      kind: "custom",
      color: "#445566",
    });
    expect(preferences.light).toEqual({ kind: "custom", color: "#112233" });
    const independent = decodeAccentColorPreferences({
      light: { kind: "preset", name: "blue" },
      dark: { kind: "preset", name: "green" },
    });
    const updated = updateAccentColorPreference(independent, "dark", {
      kind: "preset",
      name: "pink",
    });
    expect(updated.light).toEqual({ kind: "preset", name: "blue" });
    expect(updated.dark).toEqual({ kind: "preset", name: "pink" });
  });
});
