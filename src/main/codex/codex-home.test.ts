import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveCodexHome } from "./codex-home";

describe("native Codex home selection", () => {
  it("selects the configured home before an inherited home and expands the user directory", () => {
    expect(
      resolveCodexHome({
        configuredHome: " ~/work-codex ",
        environment: { CODEX_HOME: path.resolve("/host/inherited") },
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "~/work-codex",
      resolvedHomePath: path.resolve("/host/user/work-codex"),
      source: "settings",
      accountHomePath: "",
      resolvedAccountHomePath: null,
    });
  });

  it("inherits CODEX_HOME when the Profile override is empty", () => {
    expect(
      resolveCodexHome({
        configuredHome: " ",
        environment: { CODEX_HOME: " /host/inherited/../codex " },
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: path.resolve("/host/codex"),
      source: "environment",
      accountHomePath: "",
      resolvedAccountHomePath: null,
    });
  });

  it("uses the native user home when neither override selects a directory", () => {
    expect(
      resolveCodexHome({
        environment: { CODEX_HOME: " " },
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: path.resolve("/host/user/.codex"),
      source: "default",
      accountHomePath: "",
      resolvedAccountHomePath: null,
    });
  });

  it("selects account credentials without changing shared native history identity", () => {
    expect(
      resolveCodexHome({
        configuredAccountHome: " ~/codex-personal ",
        environment: {},
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: path.resolve("/host/user/.codex"),
      source: "default",
      accountHomePath: "~/codex-personal",
      resolvedAccountHomePath: path.resolve("/host/user/codex-personal"),
    });
    expect(() =>
      resolveCodexHome({
        configuredAccountHome: "relative/account",
        environment: {},
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toThrow("Codex account directory must be an absolute path or start with ~/.");
  });

  it.each([
    { configuredHome: "relative/codex", environment: {} },
    { configuredHome: "", environment: { CODEX_HOME: "relative/codex" } },
  ])("rejects a relative home instead of silently selecting another account: %j", (input) => {
    expect(() => resolveCodexHome({ ...input, homeDirectory: path.resolve("/host/user") })).toThrow(
      "Codex home must be an absolute path or start with ~/.",
    );
  });
});
