import { describe, expect, test } from "vite-plus/test";
import { footerText, resolveFooterLanguage, formatFooterNumber } from "./thread-footer-i18n";

describe("message action language", () => {
  test.each([
    ["zh-Hans-HK", "zh-Hans"],
    ["zh-Hant-CN", "zh-Hant"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-Hans", "zh-Hans"],
    ["zh-Hant", "zh-Hant"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["en-GB", "en"],
    ["fr-FR", "en"],
  ])("resolves %s to %s", (locale, expected) => {
    expect(resolveFooterLanguage(locale)).toBe(expected);
  });
  test("translates labels and interpolates durations without changing content", () => {
    expect(footerText("Copy response", {}, "zh-CN")).toBe("复制回复");
    expect(footerText("Copy response", {}, "zh-TW")).toBe("複製回覆");
    expect(footerText("Copy response", {}, "fr-FR")).toBe("Copy response");
    expect(footerText("Goal achieved in {totalTime}", { totalTime: "2m" }, "zh-CN")).toBe(
      "目标已完成，用时 2m",
    );
    expect(formatFooterNumber(1234, "en-US")).toBe("1,234");
  });
});
