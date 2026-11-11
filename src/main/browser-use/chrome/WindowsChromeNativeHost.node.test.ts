import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { createWindowsChromeNativeHost } from "./WindowsChromeNativeHost";
import { TEST_CHROME_AUTHORITY } from "./chrome-test-fixture";

test("verifies both copies before publishing an exact-origin Windows manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-browser-host-"));
  try {
    const state = path.join(root, "state");
    const source = path.join(root, "source.exe");
    const target = path.join(state, "manifest.json");
    const bytes = Buffer.from("attested PE fixture");
    await fs.writeFile(source, bytes);
    const attest = vi.fn(async (_candidate: string) => {});
    const installer = createWindowsChromeNativeHost({
      authority: TEST_CHROME_AUTHORITY,
      channel: "prod",
      expectedNativeHost: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      },
      localAppData: root,
      runtimeStateHome: state,
      statePath: state,
      runtimePaths: {
        browserClientPath: source,
        browserServicePath: source,
        codexCliPath: source,
        nativeHostPath: source,
        nodePath: source,
        nodeModuleDirs: [],
        nodeReplPath: source,
        resourcesPath: root,
      },
      runtimeVersion: "1.2.3",
      security: {
        verify: async () => {},
        ensureDirectory: async (directory) => {
          await fs.mkdir(directory, { recursive: true });
        },
      },
      verifyPlatformArtifact: attest,
    });
    await fs.writeFile(source, Buffer.concat([bytes, Buffer.of(0)]));
    await expect(installer.install(target)).rejects.toThrow("manifest artifact");
    await fs.writeFile(source, Buffer.alloc(bytes.length));
    await expect(installer.install(target)).rejects.toThrow("hash check");
    await fs.writeFile(source, bytes);

    attest.mockRejectedValueOnce(new Error("PE machine type mismatch"));
    await expect(installer.install(target)).rejects.toThrow("PE machine type mismatch");
    attest.mockImplementation(async (candidate) => {
      if (candidate !== source) throw new Error("Authenticode publisher mismatch");
    });
    await expect(installer.install(target)).rejects.toThrow("Authenticode publisher mismatch");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });

    attest.mockResolvedValue(undefined);
    await installer.install(target);
    expect(await fs.readFile(installer.nativeHostPath)).toEqual(bytes);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toMatchObject({
      path: installer.nativeHostPath,
      type: "stdio",
      allowed_origins: TEST_CHROME_AUTHORITY.extensionIds.map(
        (id) => "chrome-extension://" + id + "/",
      ),
    });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
