import { describe, expect, test } from "vite-plus/test";
import { resolveTerminalCommand, terminalShellCandidates } from "./TerminalEnvironment";

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

  test("does not add POSIX shell flags on Windows", () => {
    expect(resolveTerminalCommand("powershell.exe", "win32")).toEqual(["powershell.exe"]);
  });
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
