import { describe, expect, test } from "bun:test";
import { getDisplayCommand } from "./command-display";

describe("getDisplayCommand", () => {
  test("strips zsh login shell wrapper", () => {
    const result = getDisplayCommand("/bin/zsh -lc 'echo hello'");
    expect(result).toBe("echo hello");
  });

  test("strips bash wrapper", () => {
    const result = getDisplayCommand("bash -lc \"rg normalize src\"");
    expect(result).toBe("rg normalize src");
  });

  test("strips powershell wrapper", () => {
    const result = getDisplayCommand("pwsh -NoProfile -Command \"Get-ChildItem src\"");
    expect(result).toBe("Get-ChildItem src");
  });

  test("strips powershell exe wrapper", () => {
    const result = getDisplayCommand("C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe -c \"Write-Host hi\"");
    expect(result).toBe("Write-Host hi");
  });

  test("does not strip env-prefixed shell wrapper", () => {
    const result = getDisplayCommand("/usr/bin/env zsh -lc 'ls -la src'");
    expect(result).toBe("/usr/bin/env zsh -lc 'ls -la src'");
  });

  test("does not strip malformed powershell flags", () => {
    const result = getDisplayCommand("pwsh -ExecutionPolicy Bypass -Command \"Write-Host hi\"");
    expect(result).toBe("pwsh -ExecutionPolicy Bypass -Command \"Write-Host hi\"");
  });

  test("keeps non-wrapper commands unchanged", () => {
    const result = getDisplayCommand("git status --short");
    expect(result).toBe("git status --short");
  });

  test("falls back safely on malformed shell command strings", () => {
    const result = getDisplayCommand("/bin/zsh -lc 'echo hello");
    expect(result).toBe("/bin/zsh -lc 'echo hello");
  });
});
