import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  discoverWindowsTerminalShells,
  resolveWindowsTerminalShell,
} from "./WindowsTerminalShells";

const roots: string[] = [];
const home = "C:\\Users\\测试";
function fixture(files: readonly string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-terminal-shells-"));
  roots.push(root);
  const local = (file: string) =>
    path.join(root, ...path.win32.normalize(file).replace(":", "").split("\\"));
  for (const file of files) {
    mkdirSync(path.dirname(local(file)), { recursive: true });
    writeFileSync(local(file), "fixture executable");
  }
  return {
    remove: (file: string) => rmSync(local(file)),
    isFile: (file: string) => {
      try {
        return statSync(local(file)).isFile();
      } catch {
        return false;
      }
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Windows terminal shell discovery", () => {
  test("falls back to cmd when no shell or usable ComSpec can be found", () => {
    const fs = fixture([]);
    expect(resolveWindowsTerminalShell({ ComSpec: "  " }, home, "git-bash", fs.isFile)).toBe(
      "cmd.exe",
    );
  });
  test.each([
    ["ProgramFiles", "C:\\Program Files", "Git\\bin\\bash.exe"],
    ["ProgramW6432", "C:\\Program Files", "Git\\bin\\bash.exe"],
    ["ProgramFiles(x86)", "C:\\Program Files (x86)", "Git\\bin\\bash.exe"],
    ["localappdata", `${home}\\AppData\\Local`, "Programs\\Git\\bin\\bash.exe"],
    ["LOCALAPPDATA", `${home}\\AppData\\Local`, "Git\\bin\\bash.exe"],
  ])("finds Git Bash under %s without PATH", (name, directory, relative) => {
    const command = path.win32.join(directory, relative);
    const fs = fixture([command]);
    expect(discoverWindowsTerminalShells({ [name]: directory }, home, fs.isFile)).toEqual([
      { id: "git-bash", command },
    ]);
  });

  test.each([
    "git-bash.exe",
    "cmd\\git.exe",
    "bin\\git.exe",
    "mingw64\\bin\\git.exe",
    "mingw32\\bin\\git.exe",
    "usr\\bin\\git.exe",
  ])("finds the console wrapper from PATH's %s", (executable) => {
    const git = path.win32.join("D:\\Portable Git", executable);
    const command = "D:\\Portable Git\\bin\\bash.exe";
    const fs = fixture([
      git,
      command,
      "D:\\Portable Git\\usr\\bin\\bash.exe",
      "C:\\Windows\\System32\\bash.exe",
    ]);
    expect(
      discoverWindowsTerminalShells(
        { Path: `${path.win32.dirname(git)};C:\\Windows\\System32` },
        home,
        fs.isFile,
      ),
    ).toEqual([{ id: "git-bash", command }]);
  });

  test("does not advertise a GUI-only launcher, a directory, or WSL bash", () => {
    const fs = fixture(["D:\\Git\\git-bash.exe", "C:\\Windows\\System32\\bash.exe"]);
    expect(
      discoverWindowsTerminalShells(
        { PATH: "D:\\Git;C:\\Windows\\System32", ProgramFiles: "D:" },
        home,
        fs.isFile,
      ),
    ).toEqual([]);
  });

  test("keeps PowerShell 7, Windows PowerShell and cmd distinct and falls back after uninstall", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const cmd = "C:\\Windows\\System32\\cmd.exe";
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const environment = {
      programfiles: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
      ComSpec: cmd,
    };
    const fs = fixture([pwsh, powershell, cmd, gitBash]);
    expect(discoverWindowsTerminalShells(environment, home, fs.isFile)).toEqual([
      { id: "pwsh", command: pwsh },
      { id: "powershell", command: powershell },
      { id: "cmd", command: cmd },
      { id: "git-bash", command: gitBash },
    ]);
    expect(resolveWindowsTerminalShell(environment, home, "automatic", fs.isFile)).toBe(pwsh);
    expect(resolveWindowsTerminalShell(environment, home, "powershell", fs.isFile)).toBe(
      powershell,
    );
    expect(resolveWindowsTerminalShell(environment, home, "cmd", fs.isFile)).toBe(cmd);
    expect(resolveWindowsTerminalShell(environment, home, "git-bash", fs.isFile)).toBe(gitBash);
    fs.remove(gitBash);
    expect(resolveWindowsTerminalShell(environment, home, "git-bash", fs.isFile)).toBe(pwsh);
    fs.remove(pwsh);
    expect(resolveWindowsTerminalShell(environment, home, "git-bash", fs.isFile)).toBe(powershell);
    fs.remove(powershell);
    expect(resolveWindowsTerminalShell(environment, home, "pwsh", fs.isFile)).toBe(cmd);
  });

  test("finds per-user PowerShell 7 and never selects Git Bash automatically", () => {
    const pwsh = `${home}\\AppData\\Local\\Microsoft\\PowerShell\\pwsh.exe`;
    const environment = { LOCALAPPDATA: `${home}\\AppData\\Local` };
    const fs = fixture([pwsh, `${home}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe`]);
    expect(resolveWindowsTerminalShell(environment, home, "automatic", fs.isFile)).toBe(pwsh);
    fs.remove(pwsh);
    expect(resolveWindowsTerminalShell(environment, home, "automatic", fs.isFile)).toBe("cmd.exe");
  });
});
