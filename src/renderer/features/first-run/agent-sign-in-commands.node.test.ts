import { describe, expect, it } from "vite-plus/test";
import { claudeInstallCommand, claudeSignInCommand } from "./agent-sign-in-commands";

describe("Claude Code setup commands", () => {
  it("uses the plain command for an ordinary profile", () => {
    expect(claudeSignInCommand({ binaryPath: "claude", configDirectory: "", windows: false })).toBe(
      "claude auth login",
    );
  });

  it("quotes an executable path a shell would otherwise split or expand", () => {
    expect(
      claudeSignInCommand({
        binaryPath: "/opt/Claude Tools/$current/claude",
        configDirectory: "",
        windows: false,
      }),
    ).toBe("'/opt/Claude Tools/$current/claude' auth login");
    expect(
      claudeSignInCommand({
        binaryPath: "C:\\Program Files\\claude.exe",
        configDirectory: "",
        windows: true,
      }),
    ).toBe("& 'C:\\Program Files\\claude.exe' auth login");
  });

  it("signs in to the directory the profile uses, keeping ~ expandable", () => {
    expect(
      claudeSignInCommand({
        binaryPath: "claude",
        configDirectory: "~/claude work",
        windows: false,
      }),
    ).toBe("CLAUDE_CONFIG_DIR=~/'claude work' claude auth login");
    expect(
      claudeSignInCommand({ binaryPath: "claude", configDirectory: "C:\\c", windows: true }),
    ).toBe("$env:CLAUDE_CONFIG_DIR='C:\\c'; claude auth login");
  });

  it("escapes quotes inside a path", () => {
    expect(
      claudeSignInCommand({ binaryPath: "/o'brien/claude", configDirectory: "", windows: false }),
    ).toBe(`'/o'"'"'brien/claude' auth login`);
  });

  it("uses each platform's own installer", () => {
    expect(claudeInstallCommand(false)).toContain("install.sh");
    expect(claudeInstallCommand(true)).toContain("install.ps1");
  });
});
