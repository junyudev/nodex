import { createHash } from "node:crypto";
import fs from "node:fs";
import asyncFs, { open as openArtifact, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { it } from "@effect/vitest";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
} from "../../shared/browser-runtime-metadata";
import {
  AGENT_RUNTIME_LAYOUT_VERSION,
  parseBundledAgentRuntimeMetadata,
} from "../../shared/codex-runtime-metadata";
import { projectBundledAppServerRuntimeIdentity } from "../../shared/browser-app-server-compatibility";
import * as componentCatalog from "../app-components/AppComponentCatalog";
import { appComponentRoot, setAppComponentTombstone } from "../app-components/AppComponentStore";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "./browser-runtime-test-fixture";
import {
  codexPackageLocation,
  localCodexPackageLocation,
  matchesPinnedCodexAppServerIdentity,
  pinnedCodexAppServerIdentity,
  resolveCodexRuntime,
  resolveCodexRuntimeEffect,
  resolveDesktopToolsEffect,
  verifyCodexPackage,
} from "./codex-runtime";
import { codexDefinition } from "../app-components/definitions/codex";
import { makeCodexActivator } from "../app-components/activation/codex";
import { codexPackageMetadataSha256 } from "../platform/node/stage-codex-package";
import { makeCodexPackage, skipsBundledCodexActivation } from "./CodexPackage";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function writeRuntime(rootPath: string): void {
  fs.mkdirSync(rootPath, { recursive: true });
  const artifactBodies = new Map([
    [
      "codex-package.json",
      JSON.stringify({
        layoutVersion: 1,
        version: "0.152.0",
        target: "aarch64-apple-darwin",
        variant: "codex",
        entrypoint: "bin/codex",
        execServer: "bin/codex-exec-server",
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      }),
    ],
    ["bin/codex", "#!/bin/sh\necho codex-app-server\n"],
    ["bin/codex-code-mode-host", "#!/bin/sh\necho host\n"],
    ["bin/codex-exec-server", "#!/bin/sh\necho exec-server\n"],
    ["codex-path/rg", "#!/bin/sh\necho rg\n"],
    ["codex-resources/zsh/bin/zsh", "#!/bin/sh\necho zsh\n"],
  ]);
  const artifacts = [...artifactBodies].map(([artifactName, body]) => {
    const artifactPath = path.join(rootPath, ...artifactName.split("/"));
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, body, "utf8");
    const executable = artifactName !== "codex-package.json";
    if (executable) fs.chmodSync(artifactPath, 0o755);
    return {
      executable,
      path: artifactName,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: Buffer.byteLength(body),
    };
  });
  fs.writeFileSync(
    path.join(rootPath, "agent-runtime.json"),
    JSON.stringify({
      releaseAsset: {
        archiveSha256: "1".repeat(64),
        archiveSize: 1,
        assetName: "codex-package-aarch64-apple-darwin.tar.gz",
        entrypointSha256: createHash("sha256")
          .update(artifactBodies.get("bin/codex") ?? "")
          .digest("hex"),
        repository: "openai/codex",
        tag: "rust-v0.152.0",
      },
      artifacts,
      appServerRuntimeVersion: "0.152.0",
      entrypoint: "bin/codex",
      layoutVersion: AGENT_RUNTIME_LAYOUT_VERSION,
      packageManifest: {
        layoutVersion: 1,
        version: "0.152.0",
        target: "aarch64-apple-darwin",
        variant: "codex",
        entrypoint: "bin/codex",
        execServer: "bin/codex-exec-server",
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      },
      runtimeFamily: "codex",
      protocolSchemaFingerprint: "2".repeat(64),
      searchPaths: ["codex-path"],
      sourceRevision: {
        commit: "855ab60c0e10dac6bc89f3e248cba3746d44f034",
        repository: "openai/codex",
        tag: "rust-v0.152.0",
      },
      targetArch: "arm64",
      targetPlatform: "darwin",
      targetTriple: "aarch64-apple-darwin",
    }),
    "utf8",
  );
}

function makeBundledRuntimeFixture(): { cleanup: () => void; resourcesPath: string } {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-agent-runtime-"));
  writeRuntime(resourcesPath);
  return {
    resourcesPath,
    cleanup: () => fs.rmSync(resourcesPath, { recursive: true, force: true }),
  };
}

function makeStagedRuntimeFixture(): { cleanup: () => void; projectRootPath: string } {
  const projectRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-agent-project-"));
  writeRuntime(path.join(projectRootPath, ".generated", "codex-runtime", "agent-runtime"));
  return {
    projectRootPath,
    cleanup: () => fs.rmSync(projectRootPath, { recursive: true, force: true }),
  };
}

it.effect("activates exactly once after absence and failed verification", () =>
  Effect.gen(function* () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-optional-codex-"));
    const location = localCodexPackageLocation({ isPackaged: true, resourcesPath: root });
    const runtime = makeCodexPackage(location, { platform: "darwin", architecture: "arm64" });
    try {
      expect(yield* runtime.activate()).toMatchObject({
        status: "unavailable",
        reason: "not-installed",
      });
      fs.writeFileSync(path.join(root, "codex-package.json"), "{}");
      expect(yield* runtime.activate()).toMatchObject({ status: "unavailable", reason: "invalid" });
      const readiness = yield* Effect.forkChild(runtime.available);
      expect(readiness.pollUnsafe()).toBeUndefined();
      writeRuntime(root);
      const artifactReads = vi.mocked(openArtifact);
      artifactReads.mockClear();
      const results = yield* Effect.all(
        [runtime.activate(), runtime.activate(), runtime.activate()],
        {
          concurrency: "unbounded",
        },
      );
      expect(results[0]).toMatchObject({ status: "available" });
      expect(results.every((result) => result === runtime.current)).toBe(true);
      expect((yield* Fiber.join(readiness)).binaryPath).toBe(path.join(root, "bin/codex"));
      expect(
        artifactReads.mock.calls.filter(([file]) => file === path.join(root, "bin/codex")),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }),
);

test("chooses the Component only on supported targets and keeps the pinned Desktop Tools pair", () => {
  const options = {
    isPackaged: true,
    platform: "darwin",
    architecture: "arm64",
    nodexHome: "/test-profile",
    resourcesPath: "/test-resources",
  };
  const definition = codexDefinition("darwin-arm64");
  const component = codexPackageLocation(options);
  expect(component).toMatchObject({
    source: "component",
    rootPath: appComponentRoot(options.nodexHome, definition),
    pin: definition.payload,
  });
  const activeIdentity = {
    ...pinnedCodexAppServerIdentity("darwin", "arm64")!,
    entrypointSha256: definition.payload.entrypointSha256,
  };
  expect(matchesPinnedCodexAppServerIdentity(activeIdentity, "darwin", "arm64")).toBe(true);
  expect(
    matchesPinnedCodexAppServerIdentity(
      { ...activeIdentity, entrypointSha256: "0".repeat(64) },
      "darwin",
      "arm64",
    ),
  ).toBe(false);
  for (const architecture of ["arm64", "x64"] as const) {
    const target = { ...options, platform: "win32", architecture };
    const windows = codexDefinition(architecture === "x64" ? "win32-x64" : "win32-arm64");
    expect(codexPackageLocation(target)).toMatchObject({
      source: "component",
      rootPath: appComponentRoot(options.nodexHome, windows),
      pin: windows.payload,
    });
    expect(
      codexPackageLocation({ ...target, isPackaged: false, projectRootPath: "/project" }).source,
    ).toBe("staged");
  }
  expect(
    codexPackageLocation({ ...options, isPackaged: false, projectRootPath: "/project" }).source,
  ).toBe("staged");
});

it.effect.skipIf(process.platform === "win32")(
  "admits and marks active only the package in the Component store",
  () =>
    Effect.gen(function* () {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-component-"));
      try {
        const store = path.join(root, "store");
        writeRuntime(store);
        const receipt = Buffer.alloc(8);
        receipt.writeBigUInt64LE(100n);
        fs.writeFileSync(path.join(store, ".installed-size"), receipt, { mode: 0o600 });
        const metadata = parseBundledAgentRuntimeMetadata(
          JSON.parse(fs.readFileSync(path.join(store, "agent-runtime.json"), "utf8")),
        )!;
        const runtime = makeCodexPackage(
          {
            source: "component",
            rootPath: path.join(root, "uninstalled"),
            missingBinaryMessage: "",
            pin: {
              metadataSha256: codexPackageMetadataSha256(metadata),
              entrypointSha256: metadata.releaseAsset.entrypointSha256,
            },
          },
          { platform: "darwin", architecture: "arm64" },
        );
        const absent = makeCodexActivator(runtime, path.join(root, "missing"));
        expect(yield* absent.activate).toMatchObject({
          status: "rejected",
          message: "Codex is not installed.",
        });
        const activator = makeCodexActivator(runtime, store);
        expect(yield* activator.isActive).toBe(false);
        expect(yield* activator.activate).toEqual({ status: "active" });
        expect(yield* activator.isActive).toBe(true);
        expect(yield* absent.isActive).toBe(false);
        expect(yield* absent.activate).toMatchObject({ status: "rejected" });
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    }),
);

it.effect("admits Desktop Tools from the build pin with no Codex files present", () =>
  Effect.gen(function* () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-optional-desktop-"));
    try {
      const runtimeRoot = localCodexPackageLocation({
        isPackaged: false,
        projectRootPath: root,
      }).rootPath;
      const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
      const pin = pinnedCodexAppServerIdentity("darwin", "arm64");
      if (!pin) throw new Error("Missing test target pin");
      const manifest = writeBrowserRuntimeFixture(bundleRoot, {
        codexCompatibilityVersion: pin.runtimeVersion,
      });
      const browser = makeTestedBrowserAppServerPair({ bundleRoot, manifest }).browser;
      const desktop = yield* resolveDesktopToolsEffect({
        isPackaged: false,
        projectRootPath: root,
        platform: "darwin",
        architecture: "arm64",
        browserRuntimePlatformArtifactVerifier: async () => null,
        conformanceCandidatePair: { appServer: pin, browser },
      });
      expect(desktop.browserRuntime).toMatchObject({ status: "available" });
      expect(fs.existsSync(path.join(runtimeRoot, "agent-runtime.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }),
);

test("packaged Codex ignores development and test absence switches", () => {
  const environment = {
    NODE_ENV: "test",
    NODEX_TEST_CODEX_ABSENT: "1",
    NODEX_DEV_CODEX_ABSENT: "1",
  };
  expect(skipsBundledCodexActivation({ isPackaged: true, environment })).toBe(false);
  expect(skipsBundledCodexActivation({ isPackaged: false, environment })).toBe(true);
});

describe("codex-runtime", () => {
  it.effect("startup interruption waits for an in-flight artifact handle to close", () =>
    Effect.gen(function* () {
      const fixture = makeBundledRuntimeFixture();
      const artifactPath = path.join(fixture.resourcesPath, "bin", "codex");
      const opened = deferred<FileHandle>();
      const finishOpen = deferred<void>();
      const originalOpen = asyncFs.open.bind(asyncFs);
      let artifactHandle: FileHandle | undefined;
      const open = vi.mocked(openArtifact).mockImplementation(async (...args) => {
        const file = await originalOpen(...args);
        if (args[0] !== artifactPath) return file;
        artifactHandle = file;
        opened.resolve(file);
        await finishOpen.promise;
        return file;
      });
      let settled = false;
      const pending = yield* Effect.forkChild(
        resolveCodexRuntimeEffect({ isPackaged: true, resourcesPath: fixture.resourcesPath }),
      );

      try {
        const file = yield* Effect.promise(() => opened.promise);
        const interruption = yield* Effect.forkChild(
          Fiber.interrupt(pending).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                settled = true;
              }),
            ),
          ),
        );
        yield* Effect.promise(() => nextTurn());
        expect(settled).toBe(false);
        expect(file.fd).toBeGreaterThanOrEqual(0);

        finishOpen.resolve();
        yield* Fiber.join(interruption);
        expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
        expect(file.fd).toBe(-1);
      } finally {
        finishOpen.resolve();
        yield* Fiber.interrupt(pending);
        if (artifactHandle)
          yield* Effect.promise(() => vi.waitFor(() => expect(artifactHandle?.fd).toBe(-1)));
        open.mockImplementation(originalOpen);
        fixture.cleanup();
      }
    }),
  );

  test("resolves the bundled Codex app-server runtime from Electron Resources", async () => {
    const fixture = makeBundledRuntimeFixture();
    try {
      const runtime = await resolveCodexRuntime({
        isPackaged: true,
        resourcesPath: fixture.resourcesPath,
      });
      expect(runtime.source).toBe("bundled");
      expect(runtime.runtimeFamily).toBe("codex");
      expect(runtime.binaryPath).toBe(path.join(fixture.resourcesPath, "bin", "codex"));
      expect(runtime.additionalSearchPaths).toEqual([
        path.join(fixture.resourcesPath, "codex-path"),
      ]);
      expect(runtime.version).toBe("0.152.0");
      expect(runtime.appServerRuntimeVersion).toBe("0.152.0");
      expect(runtime.rootPath).toBe(fixture.resourcesPath);
      expect(runtime.browserRuntime).toMatchObject({
        reason: "not-installed",
        status: "unavailable",
      });
      expect(runtime.missingBinaryMessage).toBe(
        "Bundled agent runtime is missing or corrupted. Reinstall Nodex.",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.effect("admits the verified Desktop Tools component once after startup", () =>
    Effect.gen(function* () {
      const fixture = makeBundledRuntimeFixture();
      const componentPin = vi.spyOn(componentCatalog, "appComponentDefinition");
      try {
        const nodexHome = path.join(fixture.resourcesPath, "profile");
        const definition = componentPin(
          { platform: "darwin", arch: "arm64", isPackaged: true },
          "desktop-tools",
        );
        const metadata = parseBundledAgentRuntimeMetadata(
          JSON.parse(
            fs.readFileSync(path.join(fixture.resourcesPath, "agent-runtime.json"), "utf8"),
          ),
        );
        if (!definition || !metadata) throw new Error("Invalid runtime fixture");

        const stagingRoot = path.join(fixture.resourcesPath, "staging");
        const bundleRoot = path.join(stagingRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
        const manifest = writeBrowserRuntimeFixture(bundleRoot, {
          codexCompatibilityVersion: metadata.appServerRuntimeVersion,
        });
        const conformanceCandidatePair = {
          ...makeTestedBrowserAppServerPair({ bundleRoot, manifest }),
          appServer: projectBundledAppServerRuntimeIdentity(metadata),
        };
        componentPin.mockReturnValue({
          ...definition,
          payload: {
            kind: "desktop-tools",
            manifestSha256: conformanceCandidatePair.browser.manifestSha256,
          },
        });
        const verifyPlatformArtifact = vi.fn(async () => null);
        const options = {
          isPackaged: true,
          platform: "darwin",
          architecture: "arm64",
          resourcesPath: fixture.resourcesPath,
          nodexHome,
          conformanceCandidatePair,
          browserRuntimePlatformArtifactVerifier: verifyPlatformArtifact,
        };
        const runtime = yield* resolveCodexRuntimeEffect(options);
        const activation = runtime.browserRuntimeActivation;
        if (activation?.source !== "component") throw new Error("Missing component activation");
        expect(runtime.browserRuntime).toMatchObject({
          status: "unavailable",
          reason: "not-installed",
        });
        expect(yield* activation.activate).toBe(runtime.browserRuntime);
        expect(verifyPlatformArtifact).not.toHaveBeenCalled();
        const waiting = yield* Effect.forkChild(activation.available);

        const published = appComponentRoot(nodexHome, definition);
        fs.mkdirSync(path.dirname(published), { recursive: true });
        fs.renameSync(stagingRoot, published);
        const publishedBundle = path.join(published, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
        const manifestPath = path.join(publishedBundle, BROWSER_RUNTIME_MANIFEST_FILENAME);
        const lockedManifest = fs.readFileSync(manifestPath);
        fs.appendFileSync(manifestPath, "\n");
        expect(yield* activation.activate).toMatchObject({
          status: "unavailable",
          reason: "invalid-manifest",
        });
        fs.writeFileSync(manifestPath, lockedManifest);

        const node = path.join(publishedBundle, manifest.entrypoints.node);
        const lockedNode = fs.readFileSync(node);
        fs.writeFileSync(node, Buffer.alloc(lockedNode.length));
        expect(yield* activation.activate).toMatchObject({
          status: "unavailable",
          reason: "artifact-integrity",
        });
        expect(runtime.browserRuntime.status).toBe("unavailable");
        fs.writeFileSync(node, lockedNode);
        verifyPlatformArtifact.mockClear();

        const [first, concurrent] = yield* Effect.all([activation.activate, activation.activate], {
          concurrency: "unbounded",
        });
        expect(first).toMatchObject({ status: "available", bundle: { rootPath: publishedBundle } });
        expect(concurrent).toBe(first);
        expect(runtime.browserRuntime).toBe(first);
        if (first.status !== "available") throw new Error(first.message);
        expect(yield* Fiber.join(waiting)).toBe(first.bundle);
        expect(yield* activation.available).toBe(first.bundle);
        const checks = verifyPlatformArtifact.mock.calls.length;
        expect(checks).toBeGreaterThan(0);
        expect(yield* activation.activate).toBe(first);
        expect(verifyPlatformArtifact).toHaveBeenCalledTimes(checks);

        const restarted = yield* resolveCodexRuntimeEffect(options);
        expect(restarted.browserRuntime).toMatchObject({
          status: "available",
          bundle: { rootPath: publishedBundle },
        });
        expect(verifyPlatformArtifact).toHaveBeenCalledTimes(checks * 2);

        yield* Effect.promise(() =>
          setAppComponentTombstone(
            { home: nodexHome, target: { platform: "darwin", arch: "arm64", isPackaged: true } },
            "desktop-tools",
            true,
          ),
        );
        expect(yield* activation.activate).toBe(first);
        expect(fs.existsSync(publishedBundle)).toBe(true);
        const removed = yield* resolveCodexRuntimeEffect(options);
        expect(removed.browserRuntime).toMatchObject({
          status: "unavailable",
          reason: "not-installed",
        });
        expect(fs.existsSync(publishedBundle)).toBe(true);
      } finally {
        componentPin.mockRestore();
        fixture.cleanup();
      }
    }),
  );

  test.each(["codex-code-mode-host", "codex-exec-server"])(
    "rejects a missing bundled %s",
    async (name) => {
      const fixture = makeBundledRuntimeFixture();
      try {
        fs.rmSync(path.join(fixture.resourcesPath, "bin", name));
        await expect(
          resolveCodexRuntime({
            isPackaged: true,
            resourcesPath: fixture.resourcesPath,
          }),
        ).rejects.toThrow(`artifact is missing: bin/${name}`);
      } finally {
        fixture.cleanup();
      }
    },
  );

  test("throws before startup when a staged runtime artifact was modified", async () => {
    const fixture = makeStagedRuntimeFixture();
    try {
      fs.appendFileSync(
        path.join(
          fixture.projectRootPath,
          ".generated",
          "codex-runtime",
          "agent-runtime",
          "bin",
          "codex-code-mode-host",
        ),
        "tampered",
      );
      await expect(
        resolveCodexRuntime({
          isPackaged: false,
          projectRootPath: fixture.projectRootPath,
        }),
      ).rejects.toThrow("artifact size does not match metadata: bin/codex-code-mode-host");
    } finally {
      fixture.cleanup();
    }
  });

  test("throws before startup when the staged runtime omits a search path", async () => {
    const fixture = makeStagedRuntimeFixture();
    try {
      fs.rmSync(
        path.join(
          fixture.projectRootPath,
          ".generated",
          "codex-runtime",
          "agent-runtime",
          "codex-path",
        ),
        { recursive: true },
      );
      await expect(
        resolveCodexRuntime({
          isPackaged: false,
          projectRootPath: fixture.projectRootPath,
        }),
      ).rejects.toThrow("artifact is missing: codex-path/rg");
    } finally {
      fixture.cleanup();
    }
  });

  test("resolves the staged runtime for unpackaged runs", async () => {
    const fixture = makeStagedRuntimeFixture();
    try {
      const runtime = await resolveCodexRuntime({
        isPackaged: false,
        projectRootPath: fixture.projectRootPath,
      });
      const runtimeRoot = path.join(
        fixture.projectRootPath,
        ".generated",
        "codex-runtime",
        "agent-runtime",
      );
      expect(runtime.source).toBe("staged");
      expect(runtime.binaryPath).toBe(path.join(runtimeRoot, "bin", "codex"));
      expect(runtime.additionalSearchPaths).toEqual([path.join(runtimeRoot, "codex-path")]);
      expect(runtime.version).toBe("0.152.0");
      expect(runtime.metadataPath).toBe(path.join(runtimeRoot, "agent-runtime.json"));
      expect(runtime.missingBinaryMessage).toBe(
        "Pinned agent runtime is missing or incomplete. Prepare the Agent runtime for this host.",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a Browser artifact pair without an exact conformance record", async () => {
    const fixture = makeStagedRuntimeFixture();
    try {
      const runtimeRoot = path.join(
        fixture.projectRootPath,
        ".generated",
        "codex-runtime",
        "agent-runtime",
      );
      writeBrowserRuntimeFixture(path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY), {
        codexCompatibilityVersion: "0.152.0",
      });
      const runtime = await resolveCodexRuntime({
        browserRuntimePlatformArtifactVerifier: async () => null,
        isPackaged: false,
        projectRootPath: fixture.projectRootPath,
      });

      expect(runtime.browserRuntime).toMatchObject({
        reason: "untested-runtime-pair",
        status: "unavailable",
      });
      expect(runtime.binaryPath).toBe(path.join(runtimeRoot, "bin", "codex"));
    } finally {
      fixture.cleanup();
    }
  });

  test("throws when the staged runtime is missing", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-agent-project-missing-"));
    try {
      await expect(
        resolveCodexRuntime({
          isPackaged: false,
          projectRootPath: fixture,
        }),
      ).rejects.toThrow("Agent runtime is missing or incomplete");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

test("validates Windows artifact integrity without POSIX executable bits", async () => {
  const fixture = makeBundledRuntimeFixture();
  try {
    const metadataPath = path.join(fixture.resourcesPath, "agent-runtime.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.targetPlatform = "win32";
    metadata.targetArch = "x64";
    metadata.targetTriple = "x86_64-pc-windows-msvc";
    metadata.packageManifest.target = metadata.targetTriple;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    for (const artifact of metadata.artifacts)
      fs.chmodSync(path.join(fixture.resourcesPath, artifact.path), 0o644);
    const location = {
      rootPath: fixture.resourcesPath,
      source: "staged",
      missingBinaryMessage: "Missing staged Codex",
    } as const;
    const runtime = await verifyCodexPackage(location, {
      platform: "win32",
      architecture: "x64",
    });
    expect(runtime.binaryPath).toBe(path.join(fixture.resourcesPath, "bin/codex"));
    await expect(
      verifyCodexPackage(location, { platform: "darwin", architecture: "arm64" }),
    ).rejects.toThrow("target does not match");
  } finally {
    fixture.cleanup();
  }
});
