import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  readThirdPartyNotices,
  resolveThirdPartyNoticesCandidates,
  THIRD_PARTY_NOTICES_FILENAME,
} from "./third-party-notices";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nodex-third-party-notices-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("third-party notices", () => {
  test("resolves the immutable packaged resource instead of a repository path", () => {
    expect(
      resolveThirdPartyNoticesCandidates({
        appPath: normalize("/Applications/Nodex.app/Contents/Resources/app.asar"),
        cwd: "/tmp",
        isPackaged: true,
        resourcesPath: normalize("/Applications/Nodex.app/Contents/Resources"),
      }),
    ).toEqual([normalize("/Applications/Nodex.app/Contents/Resources/THIRD_PARTY_NOTICES.txt")]);
  });

  test("reads the repository resource in development and returns null when it is absent", async () => {
    const appPath = await createTempDirectory();
    const resourcesPath = join(appPath, "packaged-resources");
    const location = { appPath, cwd: appPath, isPackaged: false, resourcesPath };

    await expect(readThirdPartyNotices(location)).resolves.toEqual({ text: null });

    const resourceDirectory = join(appPath, ".generated", "build-resources");
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(
      join(resourceDirectory, THIRD_PARTY_NOTICES_FILENAME),
      "dependency notices\n",
      "utf8",
    );

    await expect(readThirdPartyNotices(location)).resolves.toEqual({
      text: "dependency notices\n",
    });
  });

  test("supports the development asset locations used by packaged desktop sources", () => {
    expect(
      resolveThirdPartyNoticesCandidates({
        appPath: normalize("/repo/nodex"),
        cwd: normalize("/repo/nodex"),
        isPackaged: false,
        resourcesPath: normalize("/electron/resources"),
      }),
    ).toEqual([
      normalize("/electron/resources/THIRD_PARTY_NOTICES.txt"),
      normalize("/repo/nodex/.generated/build-resources/THIRD_PARTY_NOTICES.txt"),
      normalize("/repo/nodex/assets/THIRD_PARTY_NOTICES.txt"),
      normalize("/repo/nodex/electron/assets/THIRD_PARTY_NOTICES.txt"),
    ]);
  });
});
