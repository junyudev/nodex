import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import {
  ComputerUseAppMaterializer,
  ComputerUseHostPlatformError,
  makeComputerUseHostPlatform,
} from "./ComputerUseHostPlatform";
import type { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-computer-use-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

it.effect("loads sky.node only from the verified Browser runtime path", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const addon = {
      computerUseServiceProcessMatchesExecutablePath: () => true,
      spawnComputerUseService: () => Promise.resolve(123),
    };
    const callbacks = {
      fork: () => null,
      runPromise: () => Promise.reject(new Error("callback runtime is unused in this test")),
    } as ScopedCallbackRuntime["Service"];
    const platform = makeComputerUseHostPlatform(
      {
        loadAddon: (verifiedPath, verifiedExports) => {
          seen.push(verifiedPath);
          assert.deepEqual(verifiedExports, ["spawnComputerUseService"]);
          return addon as never;
        },
        platform: "darwin",
        verifiedSkyNativeAddonPath: "/verified/browser-runtime/native/sky.node",
        verifiedSkyNativeExports: ["spawnComputerUseService"],
      },
      callbacks,
    );

    assert.strictEqual(yield* platform.loadAddon, addon);
    assert.deepEqual(seen, ["/verified/browser-runtime/native/sky.node"]);
  }),
);

it.effect("fails closed when the verified Browser runtime has no exact export contract", () =>
  Effect.gen(function* () {
    const loadAddon = vi.fn(() => {
      throw new Error("must not load without an ABI contract");
    });
    const callbacks = {
      fork: () => null,
      runPromise: () => Promise.reject(new Error("callback runtime is unused in this test")),
    } as ScopedCallbackRuntime["Service"];
    const platform = makeComputerUseHostPlatform(
      {
        loadAddon,
        platform: "darwin",
        verifiedSkyNativeAddonPath: "/verified/browser-runtime/native/sky.node",
      },
      callbacks,
    );

    assert.isNull(yield* platform.loadAddon);
    assert.strictEqual(loadAddon.mock.calls.length, 0);
  }),
);

const copyDirectory = (source: string, target: string) =>
  Effect.tryPromise({
    try: () => fs.promises.cp(source, target, { recursive: true }),
    catch: (cause) => new ComputerUseHostPlatformError({ operation: "test.copy", cause }),
  });

it.effect("refreshes the canonical helper atomically and reuses a verified build", () =>
  Effect.gen(function* () {
    const root = makeTemporaryRoot();
    const sourceAppPath = path.join(root, "source", "Codex Computer Use.app");
    const sourceExecutable = path.join(sourceAppPath, "Contents", "MacOS", "SkyComputerUseService");
    fs.mkdirSync(path.dirname(sourceExecutable), { recursive: true });
    fs.writeFileSync(sourceExecutable, "signed-helper");
    fs.chmodSync(sourceExecutable, 0o755);
    const copyApp = vi.fn(copyDirectory);
    const verifyApp = vi.fn((input: { serviceExecutablePath: string }) =>
      Effect.sync(() => {
        assert.strictEqual(fs.readFileSync(input.serviceExecutablePath, "utf8"), "signed-helper");
      }),
    );
    const materializer = new ComputerUseAppMaterializer({
      bundleIdentifier: "com.openai.sky.CUAService",
      copyApp,
      desktopBuild: "test-build",
      runtimeStateHome: path.join(root, "state"),
      signingTeamId: "TESTTEAM",
      sourceAppPath,
      verifyApp,
    });

    const first = yield* materializer.materialize();
    const second = yield* materializer.materialize();

    assert.deepEqual(second, first);
    assert.strictEqual(copyApp.mock.calls.length, 1);
    assert.strictEqual(verifyApp.mock.calls.length, 3);
    assert.strictEqual(
      first.appPath,
      path.join(root, "state", "computer-use", "Codex Computer Use.app"),
    );
  }),
);

it.effect("restores the prior canonical helper when post-swap verification fails", () =>
  Effect.gen(function* () {
    const root = makeTemporaryRoot();
    const sourceAppPath = path.join(root, "source", "Codex Computer Use.app");
    const sourceExecutable = path.join(sourceAppPath, "Contents", "MacOS", "SkyComputerUseService");
    fs.mkdirSync(path.dirname(sourceExecutable), { recursive: true });
    fs.writeFileSync(sourceExecutable, "old-helper");
    fs.chmodSync(sourceExecutable, 0o755);
    const runtimeStateHome = path.join(root, "state");
    const baseOptions = {
      bundleIdentifier: "com.openai.sky.CUAService",
      copyApp: copyDirectory,
      runtimeStateHome,
      signingTeamId: "TESTTEAM",
      sourceAppPath,
    };
    const first = new ComputerUseAppMaterializer({
      ...baseOptions,
      desktopBuild: "build-1",
      verifyApp: () => Effect.void,
    });
    const canonical = yield* first.materialize();
    fs.writeFileSync(sourceExecutable, "new-helper");

    const upgrade = new ComputerUseAppMaterializer({
      ...baseOptions,
      desktopBuild: "build-2",
      verifyApp: ({ appPath, serviceExecutablePath }) =>
        Effect.gen(function* () {
          if (
            !path.basename(appPath).startsWith(".staging-") &&
            fs.readFileSync(serviceExecutablePath, "utf8") === "new-helper"
          ) {
            return yield* new ComputerUseHostPlatformError({
              operation: "test.verify",
              cause: new Error("post-swap validation failed"),
            });
          }
        }),
    });

    const exit = yield* Effect.exit(upgrade.materialize());
    assert.isTrue(exit._tag === "Failure");
    assert.strictEqual(fs.readFileSync(canonical.serviceExecutablePath, "utf8"), "old-helper");
  }),
);
