import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { installCliCommand } from "./cli-command-installer";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "nodex-cli-installer-"));
  temporaryDirectories.push(directory);
  return directory;
};

const makePackagedCli = (root: string, appName = "Nodex.app"): string => {
  const cli = join(root, appName, "Contents/Resources/bin/nodex");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(cli, 0o755);
  return cli;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("installCliCommand", () => {
  test("installs one symlink to the packaged CLI and detects PATH", () => {
    const root = makeTemporaryDirectory();
    const sourcePath = makePackagedCli(root);
    const targetPath = join(root, ".local/bin/nodex");

    const result = installCliCommand({
      environmentPath: [join(root, ".local/bin"), "/usr/bin"].join(delimiter),
      sourcePath,
      targetPath,
    });

    expect(result).toMatchObject({
      pathConfigured: true,
      sourcePath,
      status: "installed",
      targetPath,
    });
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(targetPath)).toBe(sourcePath);
  });

  test("is idempotent and updates only an earlier Nodex app symlink", () => {
    const root = makeTemporaryDirectory();
    const previousSource = makePackagedCli(join(root, "previous"));
    const sourcePath = makePackagedCli(join(root, "current"));
    const targetPath = join(root, ".local/bin/nodex");
    mkdirSync(dirname(targetPath), { recursive: true });
    symlinkSync(previousSource, targetPath);

    expect(
      installCliCommand({
        sourcePath,
        targetPath,
      }).status,
    ).toBe("updated");
    expect(readlinkSync(targetPath)).toBe(sourcePath);
    expect(
      installCliCommand({
        sourcePath,
        targetPath,
      }).status,
    ).toBe("already-installed");
  });

  test("refuses to overwrite files and unrelated symlinks", () => {
    const root = makeTemporaryDirectory();
    const sourcePath = makePackagedCli(root);
    const targetPath = join(root, ".local/bin/nodex");
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "unrelated");

    expect(() =>
      installCliCommand({
        sourcePath,
        targetPath,
      }),
    ).toThrow("existing non-symlink");

    rmSync(targetPath);
    symlinkSync("/usr/bin/true", targetPath);
    expect(() =>
      installCliCommand({
        sourcePath,
        targetPath,
      }),
    ).toThrow("not managed by Nodex");
  });
});
