import { describe, expect, test } from "vite-plus/test";
import {
  OPENCODE_INSTALLER_LOG_LINE_LIMIT,
  projectOpenCodeInstallerLog,
} from "./opencode-install-log";

const ESC = "\u001b";

describe("installer output", () => {
  test("shows text without color, cursor or title escapes", () => {
    expect(
      projectOpenCodeInstallerLog(
        `${ESC}]0;install${ESC}\\${ESC}[0;2mInstalling ${ESC}[0mopencode ${ESC}[0;2mversion: ${ESC}[0m2.0.18\n` +
          `${ESC}[?25l${ESC}[0;31mFailed to fetch version information${ESC}[0m\n`,
      ),
    ).toEqual({
      lines: ["Installing opencode version: 2.0.18", "Failed to fetch version information"],
      progress: null,
    });
  });

  test("overwrites in place after carriage returns, but treats CRLF as a line break", () => {
    expect(projectOpenCodeInstallerLog("abcdef\rXY\nfirst\r\nsecond\r")).toEqual({
      lines: ["XYcdef", "first", "second"],
      progress: null,
    });
  });

  test("reports the latest share from a redrawn meter and keeps the meter out of the log", () => {
    expect(
      projectOpenCodeInstallerLog(
        "Installing opencode version: 2.0.18\n" +
          "\r###                                   7.5%" +
          "\r##############                       42.5%",
      ),
    ).toEqual({ lines: ["Installing opencode version: 2.0.18"], progress: 0.425 });
  });

  test("keeps a completed download at full progress while later steps print", () => {
    expect(
      projectOpenCodeInstallerLog(
        `\r${"#".repeat(60)} 100.0%\n` +
          "Successfully added opencode to $PATH in /Users/me/.zshrc\n",
      ),
    ).toEqual({
      lines: ["Successfully added opencode to $PATH in /Users/me/.zshrc"],
      progress: 1,
    });
  });

  test("recognizes the installer's own terminal meter", () => {
    expect(
      projectOpenCodeInstallerLog(`\r${ESC}[38;5;214m■■■■■･････････  36%${ESC}[0m`).progress,
    ).toBe(0.36);
  });

  test("stays indeterminate when a transfer never reports its size", () => {
    expect(projectOpenCodeInstallerLog("Downloading\n\r#=#=#\r-=O=-   #   #\n")).toEqual({
      lines: ["Downloading"],
      progress: null,
    });
  });

  test("drops block-art lettering but keeps indentation and single blank lines", () => {
    expect(
      projectOpenCodeInstallerLog(
        "\n\n                    ▄\n█▀▀█ █░░█ ▀▀▀▀   \n\n\n\ncd <project>  # Open directory\n\n\n" +
          "  export PATH=/Users/me/.opencode/bin:$PATH\n\n",
      ).lines,
    ).toEqual([
      "cd <project>  # Open directory",
      "",
      "  export PATH=/Users/me/.opencode/bin:$PATH",
    ]);
  });

  test("bounds scrollback and line length", () => {
    const raw = Array.from({ length: OPENCODE_INSTALLER_LOG_LINE_LIMIT + 50 }, (_, index) =>
      index === OPENCODE_INSTALLER_LOG_LINE_LIMIT + 49 ? "x".repeat(1_000) : `line ${index}`,
    ).join("\n");
    const { lines } = projectOpenCodeInstallerLog(raw);
    expect(lines).toHaveLength(OPENCODE_INSTALLER_LOG_LINE_LIMIT);
    expect(lines[0]).toBe("line 50");
    expect(lines.at(-1)).toHaveLength(400);
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
  });

  test("an empty tail has no lines and no progress", () => {
    expect(projectOpenCodeInstallerLog("")).toEqual({ lines: [], progress: null });
  });
});
