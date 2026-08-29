import { describe, expect, test } from "vite-plus/test";
import path from "node:path";
import { resolveBootstrapNodexHome } from "./bootstrap-config";

function makeVirtualFs(files: Record<string, string>) {
  return {
    exists: (filePath: string) => Object.prototype.hasOwnProperty.call(files, filePath),
    readFile: (filePath: string) => files[filePath] ?? "",
  };
}

describe("resolveBootstrapNodexHome", () => {
  test("prefers NODEX_HOME and resolves relative env paths from cwd", () => {
    const cwd = "/workspace/project";

    expect(
      resolveBootstrapNodexHome({
        isPackaged: false,
        cwd,
        env: { NODEX_HOME: "relative-data" },
        homeDir: "/home/user",
      }),
    ).toBe(path.join(cwd, "relative-data"));
  });

  test("requires an explicit Profile for unpackaged Desktop startup", () => {
    const files = makeVirtualFs({
      "/workspace/project/.nodex/config.toml": '[server]\nhome = "legacy-development-home"\n',
    });

    expect(() =>
      resolveBootstrapNodexHome({
        isPackaged: false,
        cwd: "/workspace/project",
        env: {},
        homeDir: "/home/user",
        exists: files.exists,
        readFile: files.readFile,
      }),
    ).toThrow(
      "Unpackaged Nodex requires NODEX_HOME. Start development with `vp run dev` or provide an isolated Profile explicitly.",
    );
  });

  test("merges user and project config with project home taking precedence", () => {
    const cwd = "/workspace/project/subdir";
    const files = makeVirtualFs({
      "/home/user/.nodex/config.toml": '[server]\nhome = "~/user-data"\n',
      "/workspace/project/.nodex/config.toml": '[server]\nhome = "project-data"\n',
    });

    expect(
      resolveBootstrapNodexHome({
        isPackaged: true,
        cwd,
        env: {},
        homeDir: "/home/user",
        exists: files.exists,
        readFile: files.readFile,
      }),
    ).toBe(path.join(cwd, "project-data"));
  });

  test("expands tilde config paths and falls back to the default Nodex home", () => {
    const files = makeVirtualFs({
      "/home/user/.nodex/config.toml": '[server]\nhome = "~/custom-nodex"\n',
    });

    expect(
      resolveBootstrapNodexHome({
        isPackaged: true,
        cwd: "/workspace/project",
        env: {},
        homeDir: "/home/user",
        exists: files.exists,
        readFile: files.readFile,
      }),
    ).toBe("/home/user/custom-nodex");

    expect(
      resolveBootstrapNodexHome({
        isPackaged: true,
        cwd: "/workspace/project",
        env: {},
        homeDir: "/home/user",
        exists: () => false,
      }),
    ).toBe("/home/user/.nodex");
  });
});
