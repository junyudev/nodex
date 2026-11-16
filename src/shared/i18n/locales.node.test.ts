import { describe, expect, test } from "vite-plus/test";
import { localeDisplayName, matchAppLocale, resolveAppLocale } from "./locales";

describe("display language matching", () => {
  test.each([
    ["zh-Hant-TW", "zh-CN"],
    [" ZH_hans_sg ", "zh-CN"],
    ["zh", "zh-CN"],
    ["en-GB", "en-US"],
    ["ja", null],
    ["", null],
  ] as const)("matches %j as %j", (tag, expected) => {
    expect(matchAppLocale(tag)).toBe(expected);
  });

  test.each([
    ["en-US", ["zh-HK"], "en-US"],
    ["zh-CN", ["en-GB"], "zh-CN"],
    [null, ["fr-FR", "zh-TW", "en-GB"], "zh-CN"],
    [null, ["en-IN", "zh-CN"], "en-US"],
    [null, ["fr-FR"], "en-US"],
    [null, [], "en-US"],
  ] as const)("resolves %j with %j as %j", (preference, systemLanguages, expected) => {
    expect(resolveAppLocale(preference, systemLanguages)).toBe(expected);
  });

  test("shows each language in its own script", () => {
    expect(localeDisplayName("en-US", "en-US")).toBe("English");
    expect(localeDisplayName("zh-CN", "zh-CN")).toBe("简体中文");
  });

  test.each([
    ["en-US", "zh-CN", "en"],
    ["zh-CN", "en-US", "zh-Hans"],
  ] as const)("names %j in %j for the tooltip", (locale, displayLocale, languageTag) => {
    const names = new Intl.DisplayNames([displayLocale], {
      type: "language",
      languageDisplay: "standard",
    });
    expect(localeDisplayName(locale, displayLocale)).toBe(names.of(languageTag));
  });
});
