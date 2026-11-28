import { describe, afterEach, expect, test, vi } from "vite-plus/test";
import codexRelease from "../../../resources/agent-runtime/codex-app-server.lock.json";
import { codexDefinition } from "./definitions/codex";
import {
  codexPackageMetadataSha256,
  makeCodexPackageMetadata,
} from "../platform/node/stage-codex-package";
import { it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "../codex/browser-runtime-test-fixture";
import { resolveBrowserRuntimeBundle } from "../codex/browser-runtime-bundle";
import { BROWSER_RUNTIME_MANIFEST_FILENAME } from "../../shared/browser-runtime-metadata";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import {
  assertArchivePathsAreSafe,
  pinnedTarExecutable,
} from "../platform/node/pinned-tar-archive";
import { writeClaudeCodeFixture } from "./claude-code-fixture";
import { makeClaudeCodeActivator } from "./activation/claude-code";
import * as Effect from "effect/Effect";
import {
  appComponentCatalog,
  appComponentDefinition,
  appComponentHome,
  type AppComponentDefinition,
} from "./AppComponentCatalog";
import {
  appComponentRoot,
  appComponentStoreRoot,
  ensureAppComponentStoreBoundary,
  hasAppComponentTombstone,
  hasAppComponentWanted,
  installAppComponent,
  installedAppComponentBytes,
  installedAppComponentRoot,
  prepareAppComponentStoreSweep,
  type AppComponentStoreInput,
  setAppComponentTombstone,
  setAppComponentWanted,
} from "./AppComponentStore";
import type { ComponentFetch } from "./AppComponentDownload";
import { isolatedClaudeProbe } from "@nodex/agent-runtime/contracts";
import type { AppComponentInstallation, AppComponentState } from "../../shared/app-components";
import { claudeCodeReadiness } from "./ClaudeCodeComponent";

async function prepareAppComponentStore(
  input: AppComponentStoreInput & { readonly appBuildVersion?: string },
): Promise<void> {
  const sweep = await prepareAppComponentStoreSweep(input);
  await sweep();
}

describe("AppComponentStore", () => {
  const id = "desktop-tools";
  const target = { platform: "darwin", arch: "arm64", isPackaged: true };
  const winTarget = (arch: string): AppComponentStoreInput["target"] => ({
    platform: "win32",
    arch,
    isPackaged: true,
    ...(process.platform === "win32"
      ? { coreExecutable: requiredNativeExecutable("core-server") }
      : {}),
  });
  const cleanups: (() => Promise<void>)[] = [];
  const sha256 = (buffer: Uint8Array) => createHash("sha256").update(buffer).digest("hex");

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function tempDir() {
    // A space and non-ASCII characters keep every case on a realistic Windows Profile path.
    const directory = await mkdtemp(path.join(tmpdir(), "nodex component 用户-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  async function fixtureTar(home: string, source: string) {
    const archive = path.join(home, "fixture.tar.gz");
    // Keep paths off tar's command line, as production does.
    await writeFile(
      archive,
      execFileSync(pinnedTarExecutable(), ["-czf", "-", "."], { cwd: source }),
    );
    return readFile(archive);
  }

  function fixtureDefinition(body: Buffer): AppComponentDefinition {
    return {
      id,
      archive: {
        assetName: "fixture.tar.gz",
        size: body.length,
        sha256: sha256(body),
        url: "https://example.test/archive",
      },
      unpackedBytes: 1024 * 1024,
      install: "at-startup",
      payload: { kind: "desktop-tools", manifestSha256: "unused" },
    };
  }

  /** Keep HTTPS policy exercised while replacing the platform transport with localhost HTTP. */
  async function serve(request: RequestListener): Promise<ComponentFetch> {
    const server = createServer(request);
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP fixture server");
    return (url, init) =>
      fetch(new URL(new URL(url).pathname, `http://127.0.0.1:${address.port}`), init);
  }

  const install = (
    home: string,
    definition: AppComponentDefinition,
    fetch: ComponentFetch,
    testTarget = target,
  ) => {
    return installAppComponent({
      home,
      target: testTarget,
      definition,
      fetch,
      signal: new AbortController().signal,
      onInstalling: () => {},
      onProgress: () => {},
    });
  };
  const partFile = (home: string, definition: AppComponentDefinition) =>
    path.join(appComponentStoreRoot(home), "downloads", `${definition.archive.sha256}.part`);

  // Components install on macOS. Staging a macOS closure and collecting the store rely on POSIX
  // file modes and unlink semantics, which a Windows host cannot represent.
  const posixHost = process.platform !== "win32";

  test.skipIf(!posixHost)(
    "publishes Desktop Tools in the layout Main verifies and records its installed size",
    async () => {
      const home = await tempDir();
      const source = path.join(home, "source");
      const manifest = writeBrowserRuntimeFixture(source);
      const pair = makeTestedBrowserAppServerPair({ bundleRoot: source, manifest });
      // Omit the empty Browser module directory and vary a mode to exercise staging.
      await rm(path.join(source, manifest.browserPlugin.nodeModuleDirs[0]!), { recursive: true });
      await chmod(path.join(source, "bin", "node"), 0o711);
      const bytes = await fixtureTar(home, source);
      const definition: AppComponentDefinition = {
        ...fixtureDefinition(bytes),
        install: "at-startup",
        payload: { kind: "desktop-tools", manifestSha256: pair.browser.manifestSha256 },
      };
      const download = await serve((req, response) => {
        if (req.url === "/archive") {
          response.writeHead(302, { location: "https://cdn.example.test/asset" }).end();
          return;
        }
        response.end(bytes);
      });
      const size = await install(home, definition, download);
      const root = appComponentRoot(home, definition);
      const resolved = await resolveBrowserRuntimeBundle({
        appServerIdentity: pair.appServer,
        platformArtifactVerifier: async () => null,
        runtimeRoot: root,
        targetPlatform: "darwin",
        targetArch: "arm64",
        testedPairs: [pair],
      });
      expect(resolved).toMatchObject({ status: "available" });
      expect((await lstat(path.join(root, "browser-runtime", "bin", "node"))).mode & 0o777).toBe(
        0o755,
      );
      const manifestBytes = (await lstat(path.join(source, BROWSER_RUNTIME_MANIFEST_FILENAME)))
        .size;
      expect(await installedAppComponentBytes({ home, target }, definition)).toBe(size);
      expect(size).toBe(
        manifest.artifacts.reduce((total, file) => total + file.size, manifestBytes) + 8,
      );
      await expect(lstat(partFile(home, definition))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test.each([false, true])(
    "resumes interrupted transfers (server ignores Range = %s)",
    async (ignoreRange) => {
      const home = await tempDir();
      const source = path.join(home, "source");
      const payload = writeClaudeCodeFixture(source, "some data");
      const bytes = await fixtureTar(home, source);
      const definition = { ...fixtureDefinition(bytes), payload };
      const split = Math.floor(bytes.length / 2);
      let disconnect: (() => void) | undefined;
      const requestedRanges: (string | undefined)[] = [];
      const fetch = await serve((request, response) => {
        requestedRanges.push(request.headers.range);
        if (!request.headers.range) {
          response.writeHead(200, { "content-length": bytes.length });
          response.write(bytes.subarray(0, split));
          disconnect = () => response.destroy();
          return;
        }
        if (ignoreRange) {
          response.end(bytes);
          return;
        }
        response.writeHead(206, {
          "content-range": `bytes ${split}-${bytes.length - 1}/${bytes.length}`,
        });
        response.end(bytes.subarray(split));
      });
      const partial = partFile(home, definition);
      const interrupted = install(home, definition, fetch);
      const failed = expect(interrupted).rejects.toMatchObject({ reason: "network" });
      await expect.poll(async () => (await lstat(partial).catch(() => null))?.size).toBe(split);
      disconnect?.();
      await failed;
      expect(await install(home, definition, fetch)).toBe(Buffer.byteLength("some data") + 8);
      expect(requestedRanges).toEqual([undefined, `bytes=${split}-`]);
      expect(
        await readFile(path.join(appComponentRoot(home, definition), "package/claude"), "utf8"),
      ).toBe("some data");
    },
  );

  test.each(["overflow", "digest"] as const)(
    "deletes the partial on %s verification failure",
    async (failure) => {
      const home = await tempDir();
      const pinned = Buffer.from("locked bytes");
      const definition = fixtureDefinition(pinned);
      const bytes =
        failure === "overflow" ? Buffer.concat([pinned, pinned]) : Buffer.alloc(pinned.length);
      const fetch = await serve((_request, response) => {
        response.write(bytes);
        response.end();
      });
      await expect(install(home, definition, fetch)).rejects.toMatchObject({ reason: "integrity" });
      await expect(lstat(partFile(home, definition))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(appComponentRoot(home, definition))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test("checks Profile volume capacity before making a request", async () => {
    const home = await tempDir();
    const definition = {
      ...fixtureDefinition(Buffer.from("archive")),
      unpackedBytes: Number.MAX_SAFE_INTEGER / 2,
    };
    const fetch = () => Promise.reject(new Error("Unexpected download"));
    await expect(install(home, definition, fetch)).rejects.toMatchObject({ reason: "disk-space" });
  });

  test("rejects an HTTPS downgrade before sending a request to the redirect", async () => {
    const home = await tempDir();
    const definition = fixtureDefinition(Buffer.from("archive"));
    const received: string[] = [];
    const fetch = await serve((request, response) => {
      received.push(request.url ?? "");
      response.writeHead(302, { location: "http://example.test/downgraded" }).end();
    });
    await expect(install(home, definition, fetch)).rejects.toMatchObject({ reason: "integrity" });
    expect(received).toEqual(["/archive"]);
  });

  /** One ustar header lets the test express paths and entry types that tar creation sanitizes. */
  function rawTar(name: string, type: string) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644\0", 100);
    header.write("00000000000\0", 124);
    header.write("00000000000\0", 136);
    header.fill(0x20, 148, 156);
    header.write(type, 156);
    header.write("payload", 157);
    header.write("ustar", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
  }

  test.each([
    ["../escape", "0"],
    ["/absolute", "0"],
    ["symlink", "2"],
    ["hardlink", "1"],
    ["device", "3"],
    ["fifo", "6"],
  ])("rejects unsafe archive entry %s without publishing", async (name, type) => {
    const home = await tempDir();
    const bytes = rawTar(name, type);
    const definition = fixtureDefinition(bytes);
    const fetch = await serve((_request, response) => response.end(bytes));
    await expect(install(home, definition, fetch)).rejects.toMatchObject({ reason: "integrity" });
    await expect(lstat(appComponentRoot(home, definition))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.each(["bin/AUX.exe", "bin/runner.exe:alternate", "bin/trailing.", "bin/trailing "])(
    "rejects a Windows-only unsafe archive name before extraction (%s)",
    async (name) => {
      const home = await tempDir();
      const archive = path.join(home, "bad.tar.gz");
      await writeFile(archive, rawTar(name, "0"));
      await expect(assertArchivePathsAreSafe(archive, true)).rejects.toThrow();
    },
  );

  test.skipIf(!posixHost)(
    "applies tombstones, keeps the current pin, and safely collects stale store files",
    async () => {
      const home = await tempDir();
      const input = { home, target, id } as const;
      await prepareAppComponentStore(input);
      const definition = appComponentDefinition(target, id)!;
      const root = appComponentRoot(home, definition);
      const paths = [
        path.join(path.dirname(root), "older"),
        path.join(path.dirname(root), ".stage-abandoned"),
        path.join(appComponentStoreRoot(home), "downloads", "older.part"),
      ];
      await Promise.all([root, ...paths].map((directory) => mkdir(directory, { recursive: true })));
      await mkdir(path.dirname(partFile(home, definition)), { recursive: true });
      await writeFile(partFile(home, definition), "current partial");
      await Promise.all([prepareAppComponentStore(input), prepareAppComponentStore(input)]);
      for (const removed of paths)
        await expect(lstat(removed)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await installedAppComponentRoot(input)).toBe(root);
      expect(await readFile(partFile(home, definition), "utf8")).toBe("current partial");
      await setAppComponentTombstone({ home, target }, id, true);
      expect(await installedAppComponentRoot(input)).toBeNull();
      await Promise.all([prepareAppComponentStore(input), prepareAppComponentStore(input)]);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(partFile(home, definition))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await hasAppComponentTombstone(home, id)).toBe(true);
    },
  );

  test("keeps the first-use marker when collecting an earlier Claude Code pin", async () => {
    const home = await tempDir();
    const definition = appComponentDefinition(target, "claude-code")!;
    const previous = path.join(path.dirname(appComponentRoot(home, definition)), "older");
    await mkdir(previous, { recursive: true });
    await setAppComponentWanted({ home, target }, definition.id, true);
    await prepareAppComponentStore({ home, target });
    await expect(lstat(previous)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await hasAppComponentWanted(home, definition.id)).toBe(true);
  });

  describe.each([
    "win32-x64",
    "win32-arm64",
    ...(process.platform === "win32" ? [] : ["darwin-arm64"]),
  ])("Claude Code staging on %s", (key) => {
    const windows = key.startsWith("win32");
    const testTarget = windows ? winTarget(key === "win32-x64" ? "x64" : "arm64") : target;
    it.effect.each(["valid", "tampered", "extra-file"] as const)(
      "admits only a staged Claude Code executable with the pinned identity (%s)",
      (content) =>
        Effect.gen(function* () {
          const component = yield* Effect.promise(async () => {
            const home = await tempDir();
            const source = path.join(home, "source");
            const payload = writeClaudeCodeFixture(source, "Claude fixture", windows);
            if (content === "extra-file") await mkdir(path.join(source, "package/empty"));
            const bytes = await fixtureTar(home, source);
            const definition = { ...fixtureDefinition(bytes), id: "claude-code" as const, payload };
            const fetch = () => Promise.resolve(new Response(new Uint8Array(bytes)));
            if (content === "extra-file") {
              await expect(install(home, definition, fetch, testTarget)).rejects.toMatchObject({
                reason: "integrity",
              });
              return null;
            }
            const root = appComponentRoot(home, definition);
            const executable = path.join(root, payload.executable.path);
            await expect(install(home, definition, fetch, testTarget)).resolves.toBe(
              payload.executable.size + 8,
            );
            if (!windows) expect((await lstat(executable)).mode & 0o777).toBe(0o755);
            expect((await lstat(path.join(root, "package/LICENSE.md"))).isFile()).toBe(true);
            if (content === "tampered")
              await writeFile(executable, Buffer.alloc(payload.executable.size));
            return { root, payload };
          });
          if (!component) return;
          const activator = yield* makeClaudeCodeActivator(component);
          expect(yield* activator.isActive).toBe(false);
          const result = yield* activator.activate;
          expect(result.status).toBe(content === "tampered" ? "rejected" : "active");
          expect(yield* activator.isActive).toBe(content === "valid");
        }),
    );
  });

  test.each(["arm64", "x64"])(
    "offers the Windows %s catalog in packaged and opted-in builds",
    (arch) => {
      const target = { platform: "win32", arch, isPackaged: true };
      const ids = (
        input: typeof target & { headless?: boolean; environment?: Record<string, string> },
      ) => appComponentCatalog(input).map(({ id }) => id);
      expect(ids(target)).toEqual(["desktop-tools", "codex", "claude-code"]);
      expect(ids({ ...target, headless: true })).toEqual(["codex", "claude-code"]);
      expect(ids({ ...target, isPackaged: false })).toEqual([]);
      expect(
        ids({ ...target, isPackaged: false, environment: { NODEX_DEV_APP_COMPONENTS: "1" } }),
      ).toEqual(ids(target));
      expect(
        ids({
          ...target,
          isPackaged: false,
          environment: { NODE_ENV: "test", NODEX_TEST_APP_COMPONENTS: "1" },
        }),
      ).toEqual(ids(target));
      expect(appComponentDefinition(target, "claude-code")?.archive.url).toContain(`win32-${arch}`);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "creates and revalidates the private Windows store, rejecting inherited ACLs and junctions",
    async () => {
      const testTarget = winTarget(process.arch);
      const home = await tempDir();
      const root = appComponentStoreRoot(home);
      await mkdir(root);
      await expect(ensureAppComponentStoreBoundary({ home, target: testTarget })).rejects.toThrow();
      await rm(root, { recursive: true });
      await ensureAppComponentStoreBoundary({ home, target: testTarget });
      await ensureAppComponentStoreBoundary({ home, target: testTarget });
      const redirected = await tempDir();
      const alias = path.join(redirected, "profile-alias");
      await symlink(home, alias, "junction");
      await expect(
        ensureAppComponentStoreBoundary({ home: alias, target: testTarget }),
      ).rejects.toThrow();
    },
  );

  test.skipIf(process.platform !== "win32")(
    "reclaims another Component when an old installed file is held without delete sharing",
    async () => {
      const home = await tempDir();
      const testTarget = winTarget(process.arch);
      const input = { home, target: testTarget };
      await ensureAppComponentStoreBoundary(input);
      const oldCodex = path.join(appComponentStoreRoot(home), "codex", "old-codex");
      const oldClaude = path.join(appComponentStoreRoot(home), "claude-code", "old-claude");
      await Promise.all([
        mkdir(oldCodex, { recursive: true }),
        mkdir(oldClaude, { recursive: true }),
      ]);
      const file = path.join(oldCodex, "codex.exe");
      await writeFile(file, "locked");
      const child = spawn(
        path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-Command",
          "$f = [IO.File]::Open($env:NODEX_COMPONENT_TEST_LOCK,'Open','Read','Read'); try { [Console]::WriteLine('locked'); [Console]::ReadLine() } finally { $f.Dispose() }",
        ],
        { windowsHide: true, env: { ...process.env, NODEX_COMPONENT_TEST_LOCK: file } },
      );
      const exited = once(child, "close");
      try {
        const lock = once(child.stdout, "data").then(([chunk]) => String(chunk).trim());
        await expect(Promise.race([lock, exited])).resolves.toBe("locked");
        const sweep = await prepareAppComponentStoreSweep(input);
        await sweep();
        await expect(lstat(oldClaude)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await lstat(file)).isFile()).toBe(true);
      } finally {
        child.stdin.end();
        await exited;
      }
      await prepareAppComponentStore(input);
      await expect(lstat(oldCodex)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("serves and installs the same Claude archive independently of Desktop cleanup", async () => {
    const nodexHome = await tempDir();
    const source = path.join(nodexHome, "claude-source");
    const payload = writeClaudeCodeFixture(source, "fixture Claude executable");
    const bytes = await fixtureTar(nodexHome, source);
    const definition: AppComponentDefinition = {
      ...fixtureDefinition(bytes),
      id: "claude-code",
      install: "on-first-use",
      payload,
    };
    const desktop = appComponentHome({ nodexHome });
    const headless = appComponentHome({ nodexHome, headless: true });
    const fetch: ComponentFetch = () => Promise.resolve(new Response(new Uint8Array(bytes)));
    const [desktopBytes, headlessBytes] = await Promise.all([
      install(desktop, definition, fetch),
      install(headless, definition, fetch),
    ]);
    expect(desktopBytes).toBe(headlessBytes);

    await setAppComponentTombstone({ home: desktop, target }, definition.id, true);
    await prepareAppComponentStore({ home: desktop, target });
    await expect(lstat(appComponentRoot(desktop, definition))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await installedAppComponentBytes({ home: headless, target }, definition)).toBe(
      headlessBytes,
    );
    expect(
      await readFile(
        path.join(appComponentRoot(headless, definition), payload.executable.path),
        "utf8",
      ),
    ).toBe("fixture Claude executable");
  });

  test.skipIf(!posixHost).each(["matching", "changed", "missing", "symlink"] as const)(
    "seeds a pinned local Codex package only when complete (%s)",
    async (variant) => {
      const home = await tempDir();
      const source = path.join(home, "source");
      const notices = path.resolve("resources/third-party/codex");
      const signal = new AbortController().signal;
      const build = codexRelease.builds["darwin-arm64"];
      const packageManifest = {
        ...codexRelease.packageManifest,
        target: build.targetTriple,
        variant: "codex" as const,
      };
      const artifacts = [];
      const artifactSizes: Record<string, number> = {};
      for (const file of codexRelease.requiredArtifacts) {
        const dest = path.join(source, file);
        await mkdir(path.dirname(dest), { recursive: true });
        const body = Buffer.from(
          file === "codex-package.json" ? JSON.stringify(packageManifest) : file,
        );
        const executable = /^(bin\/|codex-path\/)/u.test(file);
        await writeFile(dest, body, { mode: executable ? 0o755 : 0o644 });
        artifacts.push({ path: file, size: body.length, sha256: sha256(body), executable });
        artifactSizes[file] = body.length;
      }
      for (const name of ["LICENSE", "NOTICE"]) {
        const body = await readFile(path.join(notices, name));
        artifacts.push({
          path: `third-party/codex/${name}`,
          size: body.length,
          sha256: sha256(body),
          executable: false,
        });
      }
      artifacts.sort((a, b) => a.path.localeCompare(b.path));

      const definition = codexDefinition("darwin-arm64");
      const metadata = makeCodexPackageMetadata({
        artifacts,
        packageManifest,
        build,
        release: {
          ...codexRelease,
          runtimeFamily: "codex",
          upstream: { ...codexRelease.upstream, repository: "openai/codex" },
        },
        target: { targetArch: "arm64", targetPlatform: "darwin", targetTriple: build.targetTriple },
      });
      const archive = await fixtureTar(home, source);
      const fixture = {
        ...definition,
        archive: { ...definition.archive, sha256: sha256(archive), size: archive.length },
        payload: {
          kind: "codex" as const,
          entrypointSha256: metadata.releaseAsset.entrypointSha256,
          metadataSha256: codexPackageMetadataSha256(metadata),
        },
      };
      const entry = path.join(source, "bin", "codex");
      const visible = path.join(home, "brew", "bin");
      await mkdir(visible, { recursive: true });
      await symlink(entry, path.join(visible, "codex"));
      const companion = path.join(source, "codex-path", "rg");
      if (variant === "changed") await writeFile(companion, "codex-path/rG");
      if (variant === "missing") await rm(companion);
      if (variant === "symlink") {
        await rename(companion, path.join(home, "rg"));
        await symlink(path.join(home, "rg"), companion);
      }
      const fetch = vi.fn<ComponentFetch>(async () => new Response(new Uint8Array(archive)));
      const bytes = await installAppComponent({
        home,
        target,
        definition: fixture,
        fetch,
        signal,
        onInstalling: () => {},
        onProgress: () => {},
        codexNoticesDirectory: notices,
        codexSeedSearch: { artifactSizes, home, searchPath: visible, isolated: true },
      });
      expect(fetch).toHaveBeenCalledTimes(variant === "matching" ? 0 : 1);
      expect(await installedAppComponentBytes({ home, target }, fixture)).toBe(bytes);
      const installed = path.join(appComponentRoot(home, fixture), "bin", "codex");
      expect((await lstat(installed)).ino).not.toBe((await lstat(entry)).ino);
      await writeFile(entry, "changed independently");
      expect(await readFile(installed, "utf8")).toBe("bin/codex");
    },
  );
});

describe("ClaudeCodeComponent", () => {
  const cases = [
    [{ status: "on-demand" }, true, "warning", "still installing"],
    [{ status: "queued" }, true, "warning", "still installing"],
    [
      { status: "downloading", receivedBytes: 10, totalBytes: 50 },
      true,
      "warning",
      "still installing",
    ],
    [{ status: "installing" }, true, "warning", "still installing"],
    [
      { status: "failed", reason: "network", message: "Retry", retryAt: 1 },
      true,
      "warning",
      "still installing",
    ],
    [
      { status: "failed", reason: "integrity", message: "Check failed", retryAt: null },
      true,
      "error",
      "could not be installed",
    ],
    [{ status: "not-installed" }, false, "warning", "turned off"],
    [{ status: "installed", installedBytes: 100 }, false, "warning", "turned off"],
    [{ status: "installed", installedBytes: 100 }, true, "ready", null],
  ] satisfies readonly [AppComponentInstallation, boolean, string, string | null][];

  test.each(cases)(
    "projects managed Claude readiness for %j (enabled %s)",
    (installation, enabled, status, message) => {
      const component: AppComponentState = {
        id: "claude-code",
        enabled,
        installation,
        downloadBytes: 50,
        removalPending: false,
      };
      const probe = isolatedClaudeProbe(claudeCodeReadiness(component));
      expect(probe).toMatchObject({ status, installed: status === "ready" });
      if (message) expect(probe.message).toContain(message);
      else expect(probe.message).toBeUndefined();
    },
  );
});
