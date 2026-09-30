import { describe, expect, it } from "vite-plus/test";
import { resolveCodexHome } from "./codex-home";

describe("native Codex home selection", () => {
  it("selects the configured home before an inherited home and expands the user directory", () => {
    expect(
      resolveCodexHome({
        configuredHome: " ~/work-codex ",
        environment: { CODEX_HOME: "/host/inherited" },
        homeDirectory: "/host/user",
      }),
    ).toEqual({
      homePath: "~/work-codex",
      resolvedHomePath: "/host/user/work-codex",
      source: "settings",
    });
  });

  it("inherits CODEX_HOME when the Profile override is empty", () => {
    expect(
      resolveCodexHome({
        configuredHome: " ",
        environment: { CODEX_HOME: " /host/inherited/../codex " },
        homeDirectory: "/host/user",
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: "/host/codex",
      source: "environment",
    });
  });

  it("uses the native user home when neither override selects a directory", () => {
    expect(
      resolveCodexHome({
        environment: { CODEX_HOME: " " },
        homeDirectory: "/host/user",
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: "/host/user/.codex",
      source: "default",
    });
  });

  it.each([
    { configuredHome: "relative/codex", environment: {} },
    { configuredHome: "", environment: { CODEX_HOME: "relative/codex" } },
  ])("rejects a relative home instead of silently selecting another account: %j", (input) => {
    expect(() => resolveCodexHome({ ...input, homeDirectory: "/host/user" })).toThrow(
      "Codex home must be an absolute path or start with ~/.",
    );
  });
});
