import { describe, expect, test } from "vite-plus/test";
import path from "node:path";
import { resolveBootstrapConfig } from "./bootstrap-config";

function makeVirtualFs(files: Record<string, string>) {
  const entries = Object.fromEntries(
    Object.entries(files).map(([file, body]) => [path.resolve(file), body]),
  );
  return {
    exists: (filePath: string) => Object.prototype.hasOwnProperty.call(entries, filePath),
    readFile: (filePath: string) => entries[filePath] ?? "",
  };
}

describe("resolveBootstrapConfig", () => {
  test("prefers NODEX_HOME and resolves relative env paths from cwd", () => {
    const cwd = path.resolve("/workspace/project");

    expect(
      resolveBootstrapConfig({
        isPackaged: false,
        cwd,
        env: { NODEX_HOME: "relative-data" },
        homeDir: path.resolve("/home/user"),
      }),
    ).toMatchObject({
      nodexHome: path.join(cwd, "relative-data"),
      profileSettingsPath: path.join(cwd, "relative-data", "config.toml"),
    });
  });

  test("requires an explicit Profile for unpackaged Desktop startup", () => {
    const files = makeVirtualFs({
      "/workspace/project/.nodex/config.toml": '[server]\nhome = "legacy-development-home"\n',
    });

    expect(() =>
      resolveBootstrapConfig({
        isPackaged: false,
        cwd: path.resolve("/workspace/project"),
        env: {},
        homeDir: path.resolve("/home/user"),
        exists: files.exists,
        readFile: files.readFile,
      }),
    ).toThrow(
      "Unpackaged Nodex requires NODEX_HOME. Start development with `vp run dev` or provide an isolated Profile explicitly.",
    );
  });

  test("merges user and project config with project home taking precedence", () => {
    const cwd = path.resolve("/workspace/project/subdir");
    const files = makeVirtualFs({
      "/home/user/.nodex/config.toml": '[server]\nhome = "~/user-data"\n',
      "/workspace/project/.nodex/config.toml": '[server]\nhome = "project-data"\n',
    });

    expect(
      resolveBootstrapConfig({
        isPackaged: true,
        cwd,
        env: {},
        homeDir: path.resolve("/home/user"),
        exists: files.exists,
        readFile: files.readFile,
      }),
    ).toMatchObject({
      nodexHome: path.join(cwd, "project-data"),
      projectBootstrapConfigPath: path.resolve("/workspace/project/.nodex/config.toml"),
      userBootstrapConfigPath: path.resolve("/home/user/.nodex/config.toml"),
    });
  });

  test("expands tilde config paths and falls back to the default Nodex home", () => {
    const files = makeVirtualFs({
      "/home/user/.nodex/config.toml": '[server]\nhome = "~/custom-nodex"\n',
    });

    expect(
      resolveBootstrapConfig({
        isPackaged: true,
        cwd: path.resolve("/workspace/project"),
        env: {},
        homeDir: path.resolve("/home/user"),
        exists: files.exists,
        readFile: files.readFile,
      }),
    ).toMatchObject({
      nodexHome: path.resolve("/home/user/custom-nodex"),
      profileSettingsPath: path.resolve("/home/user/custom-nodex/config.toml"),
    });

    expect(
      resolveBootstrapConfig({
        isPackaged: true,
        cwd: path.resolve("/workspace/project"),
        env: {},
        homeDir: path.resolve("/home/user"),
        exists: () => false,
      }),
    ).toMatchObject({
      nodexHome: path.resolve("/home/user/.nodex"),
      profileSettingsPath: path.resolve("/home/user/.nodex/config.toml"),
    });
  });

  test("fails closed when an existing bootstrap config is malformed", () => {
    const files = makeVirtualFs({
      "/home/user/.nodex/config.toml": "[server\n",
    });

    expect(() =>
      resolveBootstrapConfig({
        isPackaged: true,
        cwd: path.resolve("/workspace/project"),
        env: {},
        homeDir: path.resolve("/home/user"),
        exists: files.exists,
        readFile: files.readFile,
      }),
    ).toThrow();
  });
});
