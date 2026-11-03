import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { WorktreeShellEnvironmentRuntime } from "../../host-runtime/WorktreeShellEnvironmentRuntime";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import { ClaudeSdk, live } from "./ClaudeSdk";
import { claudeSdkModuleUrl } from "./ClaudeSdkModule";

it.effect("packaged Main and history workers share the standalone SDK through Unicode paths", () =>
  Effect.gen(function* () {
    const resourcesPath = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex SDK 用户 "))),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    const url = claudeSdkModuleUrl({ isPackaged: true, resourcesPath, projectRootPath: "/unused" });
    const modulePath = join(
      resourcesPath,
      "app.asar.unpacked/out/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    );
    expect(fileURLToPath(url)).toBe(modulePath);
    yield* Effect.promise(() => mkdir(dirname(modulePath), { recursive: true }));
    yield* Effect.promise(() =>
      writeFile(
        modulePath,
        "export const owner = 'agent-runtime'; export async function listSessions() { return [{sessionId:'packaged',summary:'Shared SDK',lastModified:1}]; }",
      ),
    );
    const module = yield* Effect.promise(() => import(url));
    expect(module.owner).toBe("agent-runtime");
    const sdkLayer = live.pipe(
      Layer.provide(mainConfigLayer({ isPackaged: true, resourcesPath })),
      Layer.provide(
        Layer.succeed(WorktreeShellEnvironmentRuntime, {
          load: Effect.die("Native history must not discover PATH"),
        }),
      ),
    );
    const sessions = yield* Effect.gen(function* () {
      const sdk = yield* ClaudeSdk;
      return yield* sdk.listSessions(
        { instance: defaultClaudeInstance(), environment: { HOME: resourcesPath } },
        0,
      );
    }).pipe(Effect.provide(sdkLayer));
    expect(sessions).toEqual([{ sessionId: "packaged", summary: "Shared SDK", lastModified: 1 }]);
    // Missing packaged assets must never fall back to the development dependency.
    yield* Effect.promise(() =>
      expect(
        import(
          claudeSdkModuleUrl({
            isPackaged: true,
            resourcesPath: join(resourcesPath, "missing"),
            projectRootPath: process.cwd(),
          })
        ),
      ).rejects.toThrow(),
    );
  }).pipe(Effect.scoped),
);

test("source tests and development use the installed SDK without requiring a staged runtime", async () => {
  const url = claudeSdkModuleUrl({
    isPackaged: false,
    resourcesPath: "/unused",
    projectRootPath: "/unused",
  });
  expect(typeof (await import(url)).query).toBe("function");
});
