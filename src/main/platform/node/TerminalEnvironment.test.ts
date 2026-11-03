import { describe, expect, test } from "vite-plus/test";
import {
  buildTerminalEnvironment,
  resolveTerminalCommand,
  terminalShellCandidates,
} from "./TerminalEnvironment";

describe("resolveTerminalCommand", () => {
  test("starts zsh as an interactive login shell", () => {
    expect(resolveTerminalCommand("/bin/zsh", "darwin")).toEqual(["/bin/zsh", "-l", "-i"]);
  });

  test("starts bash with its login and interactive flags", () => {
    expect(resolveTerminalCommand("/bin/bash", "linux")).toEqual(["/bin/bash", "--login", "-i"]);
  });

  test("starts unknown POSIX shells interactively without assuming login support", () => {
    expect(resolveTerminalCommand("/bin/sh", "linux")).toEqual(["/bin/sh", "-i"]);
  });

  test.each(["powershell.exe", "cmd.exe"])(
    "preserves %s interactive startup on Windows",
    (shell) => {
      expect(resolveTerminalCommand(shell, "win32")).toEqual([shell]);
    },
  );
});

test("finds machine PowerShell 7 and the user ZIP installer's default outside PATH", () => {
  expect(
    terminalShellCandidates("win32", {
      programfiles: "C:\\Program Files",
      localappdata: "C:\\Users\\测试\\AppData\\Local",
    }),
  ).toEqual([
    "pwsh.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Users\\测试\\AppData\\Local\\Microsoft\\PowerShell\\pwsh.exe",
    "powershell.exe",
    "cmd.exe",
  ]);
});

test("terminal children have one Windows PATH and no inherited Electron Node mode", () => {
  expect(
    buildTerminalEnvironment(
      {
        Path: "old",
        PATH: "new",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect",
        term: "inherited-terminal",
        TERMINFO: "keep-on-windows",
      },
      "win32",
    ),
  ).toEqual({ PATH: "new", TERM: "xterm-256color", TERMINFO: "keep-on-windows" });
});

test("prefers PowerShell 7 and retains Windows PowerShell and cmd fallbacks", () => {
  expect(
    terminalShellCandidates("win32", {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }),
  ).toEqual([
    "pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "powershell.exe",
    "C:\\Windows\\System32\\cmd.exe",
  ]);
});
