// @effect-diagnostics asyncFunction:off - Node adapter filesystem resolution is the boundary under test.
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  claudeExecutableCandidates,
  claudeNativeHome,
  claudeWindowsPackageEntries,
  resolveClaudeExecutable,
} from "./ClaudeExecutable";

test("Windows launch resolution accepts native environment casing and npm entrypoints", () => {
  const environment = {
    Path: "bin;C:\\tools",
    PATHEXT: ".EXE;.CMD",
    USERPROFILE: "C:\\users\\dev",
  };
  expect(claudeExecutableCandidates("claude", environment, "win32", "C:\\workspace")).toEqual([
    "C:\\workspace\\bin\\claude",
    "C:\\workspace\\bin\\claude.exe",
    "C:\\workspace\\bin\\claude.cmd",
    "C:\\tools\\claude",
    "C:\\tools\\claude.exe",
    "C:\\tools\\claude.cmd",
  ]);
  expect(claudeExecutableCandidates("~/bin/claude.exe", environment, "win32")).toEqual([
    "C:\\users\\dev\\bin\\claude.exe",
  ]);
  expect(claudeWindowsPackageEntries("C:\\tools\\claude.cmd")).toEqual([
    "C:\\tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    "C:\\tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
  ]);
  expect(claudeNativeHome(environment, "win32")).toBe("C:\\users\\dev");
  expect(claudeExecutableCandidates("~/bin/claude", {}, "darwin")).toEqual([]);
});

test("relative PATH entries belong to the explicit Claude workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-claude-executable-"));
  try {
    await mkdir(join(root, "bin"));
    const executable = join(root, "bin", "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    const resolved = await resolveClaudeExecutable(
      "claude",
      { PATH: "missing:bin" },
      "darwin",
      root,
    );
    expect(resolved.endsWith("/bin/claude")).toBe(true);
    await expect(
      resolveClaudeExecutable("claude", { PATH: "bin" }, "darwin", join(root, "missing")),
    ).rejects.toThrow("was not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
