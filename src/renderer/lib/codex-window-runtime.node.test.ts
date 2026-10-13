import { describe, expect, test } from "vite-plus/test";
import {
  isCodexCompactWindowUrl,
  resolveCodexRendererCommandPlatform,
  resolveCodexRendererOsFromText,
  resolveCodexRendererWindowChrome,
} from "./codex-window-runtime";

describe("codex window runtime helpers", () => {
  test.each([
    ["MacIntel", "", "macOS"],
    ["Win32", "", "windows"],
    ["Linux x86_64", "", "linux"],
    ["", "Linux browser", "linux"],
    ["Plan 9", "", "linux"],
  ] as const)("projects %s/%s to command platform %s", (platform, userAgent, expected) => {
    expect(resolveCodexRendererCommandPlatform({ platform, userAgent })).toBe(expected);
  });

  test("normalizes renderer OS from navigator platform text", () => {
    expect(resolveCodexRendererOsFromText("MacIntel")).toBe("darwin");
    expect(resolveCodexRendererOsFromText("Win32")).toBe("win32");
    expect(resolveCodexRendererOsFromText("Linux x86_64")).toBe("linux");
    expect(resolveCodexRendererOsFromText("Plan 9")).toBe("unknown");
  });

  test("matches Codex Electron window chrome by platform", () => {
    expect(resolveCodexRendererWindowChrome("browser", "win32")).toBe("native");
    expect(resolveCodexRendererWindowChrome("electron", "darwin")).toBe("native");
    expect(resolveCodexRendererWindowChrome("electron", "unknown")).toBe("native");
    expect(resolveCodexRendererWindowChrome("electron", "linux")).toBe("application-menu");
    expect(resolveCodexRendererWindowChrome("electron", "win32")).toBe("application-menu");
  });

  test("detects compact Codex window routes", () => {
    expect(isCodexCompactWindowUrl("app://-/avatar-overlay")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/global-dictation")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/global-dictation/session")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/hotkey-window")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/?initialRoute=/hotkey-window")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/?initialRoute=/avatar-overlay?x=1")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/")).toBe(false);
    expect(isCodexCompactWindowUrl("app://-/settings")).toBe(false);
    expect(isCodexCompactWindowUrl("not a url")).toBe(false);
  });
});
