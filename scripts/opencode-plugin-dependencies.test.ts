import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openCodeAgent } from "../src/shared/agents/opencode";
import { seedOpenCodePluginDependencies } from "./opencode-plugin-dependencies";

const plugin = "@opencode-ai/plugin";
const version = "1.19.2";

describe.skipIf(process.platform === "win32")("OpenCode plugin dependencies", () => {
  let root: string;
  let bin: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nodex-opencode-deps-"));
    bin = path.join(root, "bin");
    await mkdir(bin);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
  });

  const fakeOpenCode = (version: string) =>
    writeFile(path.join(bin, "opencode"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, {
      mode: 0o700,
    });

  async function profile(name = "profile") {
    const nodexHome = path.join(root, name);
    await mkdir(nodexHome);
    return {
      nodexHome,
      projectRoot: root,
      environment: { PATH: bin, HOME: root },
      cachePath: path.join(root, "cache"),
      config: path.join(
        nodexHome,
        "agents",
        openCodeAgent.driver,
        openCodeAgent.profile.initialId,
        "config",
        openCodeAgent.driver,
      ),
    };
  }

  async function fakeInstall(directory: string) {
    const installed = path.join(directory, "node_modules", plugin);
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, "package.json"), JSON.stringify({ version }));
    await writeFile(
      path.join(directory, "package-lock.json"),
      JSON.stringify({ packages: { "": { dependencies: { [plugin]: version } } } }),
    );
  }

  test("preserves existing npm metadata and even a dangling dependency link", async () => {
    await fakeOpenCode(version);
    const withManifest = await profile("manifest");
    const withLink = await profile("link");
    await mkdir(withManifest.config, { recursive: true });
    await mkdir(withLink.config, { recursive: true });
    await writeFile(path.join(withManifest.config, "package.json"), "{}");
    const oldTarget = path.join(root, "missing");
    await symlink(oldTarget, path.join(withLink.config, "node_modules"));

    await seedOpenCodePluginDependencies({ ...withManifest, install: fakeInstall });
    await seedOpenCodePluginDependencies({ ...withLink, install: fakeInstall });

    expect(await readFile(path.join(withManifest.config, "package.json"), "utf8")).toBe("{}");
    expect(await readlink(path.join(withLink.config, "node_modules"))).toBe(oldTarget);
    await expect(lstat(withManifest.cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["1.15.12", "2.4.2"])(
    "skips OpenCode %s outside the npm-installing 1.x range",
    async (other) => {
      await fakeOpenCode(other);
      const input = await profile();
      await seedOpenCodePluginDependencies({ ...input, install: fakeInstall });
      await expect(lstat(input.config)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(input.cachePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("gives concurrent Profiles independent metadata and the same installed dependencies", async () => {
    await fakeOpenCode(version);
    const inputs = await Promise.all([profile("first"), profile("second")]);
    const install = vi.fn(fakeInstall);
    await Promise.all(inputs.map((input) => seedOpenCodePluginDependencies({ ...input, install })));

    const targets = await Promise.all(
      inputs.map(async ({ config }) => {
        const target = await readlink(path.join(config, "node_modules"));
        const manifest = path.join(config, "package.json");
        const lock = path.join(config, "package-lock.json");
        expect(JSON.parse(await readFile(manifest, "utf8"))).toEqual({
          dependencies: { [plugin]: version },
        });
        expect(await readFile(lock, "utf8")).toBe(
          await readFile(path.join(target, "..", "package-lock.json"), "utf8"),
        );
        expect((await lstat(manifest)).isFile()).toBe(true);
        expect((await lstat(lock)).isFile()).toBe(true);
        return target;
      }),
    );
    expect(targets[0]).toBe(targets[1]);
    expect(install).toHaveBeenCalledTimes(1);
  });

  test("warns once and leaves OpenCode free to install when preparation fails", async () => {
    await fakeOpenCode(version);
    const input = await profile();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedOpenCodePluginDependencies({
      ...input,
      install: async (directory) => {
        await fakeInstall(directory);
        await writeFile(path.join(directory, "package-lock.json"), "{}");
      },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`lockfile is missing ${plugin}`));
    await expect(lstat(input.config)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
