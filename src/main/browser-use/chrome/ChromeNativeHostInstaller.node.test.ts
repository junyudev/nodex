import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { TEST_CHROME_AUTHORITY, TEST_CHROME_HOST_NAME } from "./chrome-test-fixture";
import {
  installChromeNativeHost,
  readChromeNativeHostIdentity,
  resolveChromeNativeHostRegistryPaths,
  type ChromeNativeHostInstallerOptions,
} from "./ChromeNativeHostInstaller";

const temporaryRoots: string[] = [];
const peerIdentity = { signingIdentifier: "com.openai.chrome-host", teamId: "TESTTEAM1A" };

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

async function makeRuntimeFile(root: string, name: string, executable: boolean): Promise<string> {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, name, { mode: executable ? 0o700 : 0o600 });
  return filePath;
}

async function makeInstallerOptions(root: string): Promise<ChromeNativeHostInstallerOptions> {
  const runtimeRoot = path.join(root, "packaged", "Resources", "browser-runtime");
  await fs.mkdir(runtimeRoot, { recursive: true });
  const runtimePaths = {
    browserClientPath: await makeRuntimeFile(runtimeRoot, "browser-client.mjs", false),
    browserServicePath: await makeRuntimeFile(runtimeRoot, "browser-service.mjs", false),
    codexCliPath: await makeRuntimeFile(runtimeRoot, "codex", true),
    nativeHostPath: await makeRuntimeFile(runtimeRoot, "ChatGPT for Chrome", true),
    nodePath: await makeRuntimeFile(runtimeRoot, "node", true),
    nodeModuleDirs: [path.join(runtimeRoot, "node_modules")],
    nodeReplPath: await makeRuntimeFile(runtimeRoot, "node-repl.mjs", false),
    resourcesPath: runtimeRoot,
  };
  await fs.mkdir(runtimePaths.nodeModuleDirs[0]!, { mode: 0o700 });
  const nativeHostBytes = await fs.readFile(runtimePaths.nativeHostPath);
  return {
    authority: TEST_CHROME_AUTHORITY,
    channel: "prod",
    expectedNativeHost: {
      sha256: createHash("sha256").update(nativeHostBytes).digest("hex"),
      signingTeamId: peerIdentity.teamId,
      size: nativeHostBytes.byteLength,
    },
    homeDirectory: path.join(root, "home"),
    runtimePaths,
    runtimeStateHome: path.join(root, "profile", "agent"),
    runtimeVersion: "26.901.20858",
    verifyNativeHost: async () => peerIdentity,
  };
}

describe("Chrome native host installer", () => {
  test("installs manifests against a verified Profile-owned native-host closure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-install-"));
    temporaryRoots.push(root);
    const options = await makeInstallerOptions(root);
    const verifiedPaths: string[] = [];

    const result = await installChromeNativeHost({
      ...options,
      verifyNativeHost: async (nativeHostPath) => {
        verifiedPaths.push(nativeHostPath);
        return peerIdentity;
      },
    });

    const expectedClosure = path.join(
      await fs.realpath(options.runtimeStateHome),
      "chrome-control",
      "native-host-v2",
      options.expectedNativeHost.sha256,
    );
    expect(result.nativeHostPath).toBe(path.join(expectedClosure, "native-host"));
    expect(result.nativeHostPath).not.toBe(options.runtimePaths.nativeHostPath);
    expect(result.peerIdentity).toEqual(peerIdentity);
    expect(verifiedPaths).toEqual([
      await fs.realpath(options.runtimePaths.nativeHostPath),
      result.nativeHostPath,
      result.nativeHostPath,
    ]);
    expect(await fs.readdir(path.dirname(options.runtimePaths.nativeHostPath))).toEqual([
      "ChatGPT for Chrome",
      "browser-client.mjs",
      "browser-service.mjs",
      "codex",
      "node",
      "node-repl.mjs",
      "node_modules",
    ]);

    expect(result.registryPaths).toEqual([
      path.join(
        await fs.realpath(options.homeDirectory),
        "Library",
        "Application Support",
        "OpenAI",
        "Codex",
        "chrome-native-hosts-v2.json",
      ),
      path.join(await fs.realpath(options.runtimeStateHome), "chrome-native-hosts-v2.json"),
    ]);
    const registries = await Promise.all(
      result.registryPaths.map(
        async (registryPath) =>
          JSON.parse(await fs.readFile(registryPath, "utf8")) as {
            entries: Array<Record<string, unknown>>;
            schemaVersion: number;
          },
      ),
    );
    expect(registries[1]).toEqual(registries[0]);
    expect(registries[0]?.schemaVersion).toBe(2);
    expect(registries[0]?.entries).toHaveLength(1);
    const entry = registries[0]!.entries[0]!;
    expect(entry).toEqual({
      appServerProtocolVersion: 2,
      appVersion: "26.901.20858",
      channel: "prod",
      cliVersion: "26.901.20858",
      entryId: expect.stringMatching(/^codex-runtime-[a-f0-9]{32}$/u),
      extensionBuildChannels: ["prod"],
      extensionIds: TEST_CHROME_AUTHORITY.extensionIds,
      installId: expect.stringMatching(/^codex-install-[a-f0-9]{32}$/u),
      nativeHostNames: [TEST_CHROME_HOST_NAME],
      nativeHostProtocolVersion: 2,
      nativeHostVersion: "26.901.20858",
      paths: {
        browserClientPath: await fs.realpath(options.runtimePaths.browserClientPath),
        browserServicePath: await fs.realpath(options.runtimePaths.browserServicePath),
        codexCliPath: await fs.realpath(options.runtimePaths.codexCliPath),
        codexHome: await fs.realpath(options.runtimeStateHome),
        extensionHostPath: result.nativeHostPath,
        nodeModuleDirs: await Promise.all(
          options.runtimePaths.nodeModuleDirs.map((directory) => fs.realpath(directory)),
        ),
        nodePath: await fs.realpath(options.runtimePaths.nodePath),
        nodeReplPath: await fs.realpath(options.runtimePaths.nodeReplPath),
        resourcesPath: await fs.realpath(options.runtimePaths.resourcesPath),
      },
      presence: {
        lastSeenAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        pid: process.pid,
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      },
      proxyHost: "127.0.0.1",
      proxyPort: 0,
      schemaVersion: 2,
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(result.manifestPaths).toHaveLength(2);
    const manifest = JSON.parse(await fs.readFile(result.manifestPaths[0]!, "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).toEqual({
      allowed_origins: TEST_CHROME_AUTHORITY.extensionIds.map(
        (extensionId) => `chrome-extension://${extensionId}/`,
      ),
      description: "ChatGPT browser native messaging host",
      name: TEST_CHROME_HOST_NAME,
      path: result.nativeHostPath,
      type: "stdio",
    });
    expect((await fs.stat(result.nativeHostPath)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(result.registryPaths[0]!)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(result.manifestPaths[0]!)).mode & 0o777).toBe(0o644);

    const firstEntryId = entry.entryId;
    const second = await installChromeNativeHost(options);
    expect(second).toEqual(result);
    const secondRegistry = JSON.parse(await fs.readFile(second.registryPaths[0]!, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(secondRegistry.entries).toHaveLength(1);
    expect(secondRegistry.entries[0]?.entryId).toBe(firstEntryId);
  });

  test("fails closed before writing when the packaged native host is rejected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-reject-"));
    temporaryRoots.push(root);
    const options = await makeInstallerOptions(root);

    await expect(
      installChromeNativeHost({
        ...options,
        verifyNativeHost: async () => {
          throw new Error("wrong signing team");
        },
      }),
    ).rejects.toThrow("wrong signing team");
    await expect(fs.stat(options.homeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(options.runtimeStateHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves unrelated official registry entries while replacing its own identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-registry-merge-"));
    temporaryRoots.push(root);
    const options = await makeInstallerOptions(root);
    const first = await installChromeNativeHost(options);
    const registryPath = first.registryPaths[0]!;
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      entries: unknown[];
      schemaVersion: 2;
    };
    const unrelated = { entryId: "official-runtime-owned-by-another-install" };
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({ ...registry, entries: [unrelated, ...registry.entries] }, null, 2)}\n`,
      { mode: 0o600 },
    );

    await installChromeNativeHost(options);

    const merged = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(merged.entries).toHaveLength(2);
    expect(merged.entries).toContainEqual(unrelated);
    expect(
      merged.entries.filter((entry) => String(entry.entryId ?? "").startsWith("codex-runtime-")),
    ).toHaveLength(1);
  });

  test("refuses to clobber an invalid existing v2 registry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-registry-invalid-"));
    temporaryRoots.push(root);
    const options = await makeInstallerOptions(root);
    await fs.mkdir(options.homeDirectory, { mode: 0o700, recursive: true });
    await fs.mkdir(options.runtimeStateHome, { mode: 0o700, recursive: true });
    const [registryPath] = resolveChromeNativeHostRegistryPaths(
      await fs.realpath(options.homeDirectory),
      await fs.realpath(options.runtimeStateHome),
    );
    await fs.mkdir(path.dirname(registryPath!), { mode: 0o700, recursive: true });
    await fs.writeFile(registryPath!, "not-json\n", { mode: 0o600 });

    await expect(installChromeNativeHost(options)).rejects.toThrow("invalid JSON");
    expect(await fs.readFile(registryPath!, "utf8")).toBe("not-json\n");
    await expect(
      fs.stat(
        path.join(
          options.homeDirectory,
          "Library/Application Support/Google/Chrome/NativeMessagingHosts",
          `${TEST_CHROME_HOST_NAME}.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a symlink in the controlled destination chain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-symlink-"));
    temporaryRoots.push(root);
    const options = await makeInstallerOptions(root);
    const outside = path.join(root, "outside");
    await fs.mkdir(options.runtimeStateHome, { mode: 0o700, recursive: true });
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, path.join(options.runtimeStateHome, "chrome-control"));

    await expect(installChromeNativeHost(options)).rejects.toThrow("not a regular directory");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test("rejects a symlink in the verified runtime parent chain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-source-symlink-"));
    temporaryRoots.push(root);
    const options = await makeInstallerOptions(root);
    const outside = path.join(root, "outside-runtime");
    await fs.mkdir(outside, { mode: 0o700 });
    const outsideService = await makeRuntimeFile(outside, "browser-service.mjs", false);
    const linkedDirectory = path.join(options.runtimePaths.resourcesPath, "linked-runtime");
    await fs.symlink(outside, linkedDirectory);

    await expect(
      installChromeNativeHost({
        ...options,
        runtimePaths: {
          ...options.runtimePaths,
          browserServicePath: path.join(linkedDirectory, path.basename(outsideService)),
        },
      }),
    ).rejects.toThrow("non-canonical parent path");
  });

  test("parses the exact code-signing identity reported by codesign", () => {
    const identity = readChromeNativeHostIdentity("/runtime/native-host", (command, args) => {
      expect(command).toBe("/usr/bin/codesign");
      expect(args).toEqual(["-dv", "--verbose=4", "/runtime/native-host"]);
      return [
        "Executable=/runtime/native-host",
        "Identifier=com.openai.chrome-host",
        "TeamIdentifier=TESTTEAM1A",
      ].join("\n");
    });

    expect(identity).toEqual(peerIdentity);
  });
});
