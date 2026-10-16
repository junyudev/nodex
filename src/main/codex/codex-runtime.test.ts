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
import { BROWSER_RUNTIME_BUNDLE_DIRECTORY } from "../../shared/browser-runtime-metadata";
import { AGENT_RUNTIME_LAYOUT_VERSION } from "../../shared/codex-runtime-metadata";
import { writeBrowserRuntimeFixture } from "./browser-runtime-test-fixture";
import { resolveCodexRuntime, resolveCodexRuntimeEffect } from "./codex-runtime";

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
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      }),
    ],
    ["bin/codex", "#!/bin/sh\necho codex-app-server\n"],
    ["bin/codex-code-mode-host", "#!/bin/sh\necho host\n"],
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
        reason: "manifest-missing",
        status: "unavailable",
      });
      expect(runtime.missingBinaryMessage).toBe(
        "Bundled agent runtime is missing or corrupted. Reinstall Nodex.",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("throws before startup when the bundled runtime omits a declared artifact", async () => {
    const fixture = makeBundledRuntimeFixture();
    try {
      fs.rmSync(path.join(fixture.resourcesPath, "bin", "codex-code-mode-host"));
      await expect(
        resolveCodexRuntime({
          isPackaged: true,
          resourcesPath: fixture.resourcesPath,
        }),
      ).rejects.toThrow("artifact is missing: bin/codex-code-mode-host");
    } finally {
      fixture.cleanup();
    }
  });

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
        "Pinned agent runtime is missing or incomplete. Run `pnpm run stage:codex-runtime:mac`.",
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
