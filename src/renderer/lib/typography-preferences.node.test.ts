import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  FONT_SIZE_LIMITS,
  MONO_FONT_FAMILY,
  SYSTEM_FONT_FAMILY,
  getTypographyCssVariables,
  normalizeFontFamily,
  normalizeFontSize,
  normalizeTypographyPreferences,
  readTypographyPreferences,
  writeTypographyPreferences,
} from "./typography-preferences";

afterEach(() => vi.unstubAllGlobals());

describe("typography preference boundary", () => {
  test("owns the public defaults and three independent size ranges", () => {
    expect(FONT_SIZE_LIMITS).toEqual({
      ui: { default: 14, min: 11, max: 16 },
      code: { default: 12, min: 8, max: 24 },
      page: { default: 14, min: 12, max: 24 },
    });
    expect(normalizeTypographyPreferences(null)).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES);
  });

  test("defaults missing or malformed font smoothing to enabled and retains explicit choices", () => {
    for (const useFontSmoothing of [undefined, null, "false", 0]) {
      expect(normalizeTypographyPreferences({ useFontSmoothing }).useFontSmoothing).toBe(true);
    }
    expect(normalizeTypographyPreferences({ useFontSmoothing: false }).useFontSmoothing).toBe(
      false,
    );
    expect(normalizeTypographyPreferences({ useFontSmoothing: true }).useFontSmoothing).toBe(true);
  });
  test.each(["ui", "code", "page"] as const)("keeps %s sizes within their own range", (role) => {
    const limits = FONT_SIZE_LIMITS[role];
    expect(normalizeFontSize(role, null)).toBe(limits.default);
    expect(normalizeFontSize(role, "16px")).toBe(limits.default);
    expect(normalizeFontSize(role, -1)).toBe(limits.min);
    expect(normalizeFontSize(role, 100)).toBe(limits.max);
    expect(normalizeFontSize(role, 12.5)).toBe(12.5);
  });

  test("scales UI tokens while keeping Page and code sizes independent", () => {
    const variables = getTypographyCssVariables(
      { ...DEFAULT_TYPOGRAPHY_PREFERENCES, uiFontSize: 16 },
      "light",
    );
    expect(variables["--text-sm"]).toBe("15px");
    expect(variables["--text-xs"]).toBe("14px");
    expect(variables["--text-heading-md"]).toBe("23px");
    expect(variables["--text-4xl"]).toBe("82px");
    expect(variables["--codex-chat-font-size"]).toBe("16px");
    expect(variables["--codex-chat-code-font-size"]).toBe("12px");
    expect(variables["--text-document"]).toBe("14px");
  });

  test("restores font roles separately by appearance and retains their fallback chains", () => {
    const preferences = normalizeTypographyPreferences({
      fonts: {
        light: { ui: '"Avenir Next"', content: "Georgia", code: "Monaco" },
        dark: { content: "serif" },
      },
    });
    const light = getTypographyCssVariables(preferences, "light");
    const dark = getTypographyCssVariables(preferences, "dark");
    expect(light["--font-ui-family"]).toBe(`"Avenir Next", ${SYSTEM_FONT_FAMILY}`);
    expect(light["--font-content"]).toBe(`Georgia, "Avenir Next", ${SYSTEM_FONT_FAMILY}`);
    expect(light["--font-code-family"]).toBe(`Monaco, ${MONO_FONT_FAMILY}`);
    expect(dark["--font-ui-family"]).toBe(SYSTEM_FONT_FAMILY);
    expect(dark["--font-content"]).toBe(`serif, ${SYSTEM_FONT_FAMILY}`);
  });

  test("rejects invalid family lists while preserving quoted names and fallback lists", () => {
    expect(normalizeFontFamily("inherit")).toBeNull();
    expect(normalizeFontFamily("Arial,")).toBeNull();
    expect(normalizeFontFamily("Arial,, serif")).toBeNull();
    expect(normalizeFontFamily('"Open Sans", serif')).toBe('"Open Sans", serif');
    expect(normalizeFontFamily('"inherit", "A, B", Arial')).toBe('"inherit", "A, B", Arial');
  });

  test("round-trips the unified envelope and recovers from unavailable or corrupt storage", () => {
    let saved: string | null = null;
    vi.stubGlobal("localStorage", {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    });
    expect(readTypographyPreferences()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES);
    const preferences = writeTypographyPreferences({
      ...DEFAULT_TYPOGRAPHY_PREFERENCES,
      useFontSmoothing: false,
      uiFontSize: 15.5,
      codeFontSize: 20,
      pageFontSize: 18,
    });
    expect(readTypographyPreferences()).toEqual(preferences);
    saved = "invalid JSON";
    expect(readTypographyPreferences()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Unavailable");
      },
      setItem: () => {
        throw new Error("Unavailable");
      },
    });
    expect(readTypographyPreferences(preferences)).toEqual(preferences);
    expect(writeTypographyPreferences(preferences)).toEqual(preferences);
  });
});
