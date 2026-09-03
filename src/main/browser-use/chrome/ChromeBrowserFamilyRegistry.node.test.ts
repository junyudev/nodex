import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  getChromeBrowserFamily,
  getChromeBrowserFamilyByBundleId,
  loadChromeBrowserAuthority,
  parseChromeBrowserAuthority,
  resolveChromeNativeMessagingManifestPaths,
} from "./ChromeBrowserFamilyRegistry";
import {
  TEST_CHROME_AUTHORITY,
  TEST_CHROME_EXTENSION_IDS,
  TEST_CHROME_FAMILY_DESCRIPTOR,
  TEST_CHROME_HOST_NAME,
} from "./chrome-test-fixture";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("Chrome browser family registry", () => {
  test("projects browser and extension authority only from the verified descriptor", () => {
    expect(TEST_CHROME_AUTHORITY.families.map(({ family }) => family)).toEqual(["chrome", "edge"]);
    expect(TEST_CHROME_AUTHORITY.extensionIds).toEqual(TEST_CHROME_EXTENSION_IDS);
    expect(
      getChromeBrowserFamilyByBundleId(TEST_CHROME_AUTHORITY, "com.microsoft.edgemac")?.family,
    ).toBe("edge");
    expect(getChromeBrowserFamily(TEST_CHROME_AUTHORITY, "firefox")).toBeNull();
    expect(getChromeBrowserFamily(TEST_CHROME_AUTHORITY, "chrome")?.browserIconAssetPath).toBe(
      "assets/google-chrome.png",
    );
  });

  test("loads an exact regular descriptor artifact and rejects authority drift", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-descriptor-"));
    temporaryRoots.push(root);
    const descriptorPath = path.join(root, "extension-ids.json");
    const bytes = Buffer.from(JSON.stringify(TEST_CHROME_FAMILY_DESCRIPTOR), "utf8");
    await fs.writeFile(descriptorPath, bytes);

    await expect(
      loadChromeBrowserAuthority({
        descriptorPath,
        expectedExtensionIds: TEST_CHROME_EXTENSION_IDS,
        expectedHostName: TEST_CHROME_HOST_NAME,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        expectedSize: bytes.byteLength,
      }),
    ).resolves.toEqual(TEST_CHROME_AUTHORITY);
    await expect(
      loadChromeBrowserAuthority({
        descriptorPath,
        expectedExtensionIds: [TEST_CHROME_EXTENSION_IDS[0]],
        expectedHostName: TEST_CHROME_HOST_NAME,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        expectedSize: bytes.byteLength,
      }),
    ).rejects.toThrow("do not match");
  });

  test("rejects descriptor-selected paths that could escape the Chrome plugin or user home", () => {
    expect(() =>
      parseChromeBrowserAuthority(
        {
          ...TEST_CHROME_FAMILY_DESCRIPTOR,
          browserExtensions: [
            {
              ...TEST_CHROME_FAMILY_DESCRIPTOR.browserExtensions[0],
              browserIconAssetPath: "../outside.png",
            },
            TEST_CHROME_FAMILY_DESCRIPTOR.browserExtensions[1],
          ],
        },
        { extensionIds: TEST_CHROME_EXTENSION_IDS, hostName: TEST_CHROME_HOST_NAME },
      ),
    ).toThrow("unsafe path segment");

    const destinations = resolveChromeNativeMessagingManifestPaths(
      "/Users/tester",
      TEST_CHROME_AUTHORITY,
    );
    expect(destinations).toHaveLength(2);
    expect(destinations.every((destination) => destination.startsWith("/Users/tester/"))).toBe(
      true,
    );
    expect(
      destinations.every((destination) => destination.endsWith(`${TEST_CHROME_HOST_NAME}.json`)),
    ).toBe(true);
  });
});
