import * as TextGeneration from "./TextGeneration.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Schedule from "effect/Schedule";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ClaudeSettings,
  ProviderInstanceId,
  ProviderDriverKind,
  TextGenerationError,
} from "@t3tools/contracts";
import { TextGenerationAdmission } from "@t3tools/provider-core/server/textGenerationPolicy";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../../../src/shared/model-policy.ts";
import { RuntimeModelPolicy, make as makePolicy } from "../nodex/ModelPolicy.ts";
import * as ServerConfig from "../config.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";

const sdk = vi.hoisted(() => ({
  prepare: async () => {},
  query: vi.fn(() => {
    throw new Error("A revoked SDK request must not launch");
  }),
}));
vi.mock("../provider/ClaudeAgentSdk.ts", () => ({
  loadClaudeAgentSdk: async () => ({
    resolveSettings: async (options: { managedSettings: unknown }) => {
      await sdk.prepare();
      return { effective: options.managedSettings, sources: [], provenance: {} };
    },
    query: sdk.query,
  }),
}));

for (const driver of ["codex", "claude", "claude-sdk"] as const) {
  it.live.each([false, true])(
    `${driver} rechecks after preparation and cancels owned credit work (%s)`,
    (credit) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-policy-launch-" });
        const marker = `${home}/launched`;
        const binaryPath = `${home}/fake-cli.cjs`;
        yield* fs.writeFileString(
          binaryPath,
          `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched'); process.exit(9);\n`,
        );
        yield* fs.chmod(binaryPath, 0o700);
        const instanceId = ProviderInstanceId.make(`${credit ? "nodex_" : ""}${driver}`);
        const model = driver === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5";
        const provider = {
          instanceId,
          driver: ProviderDriverKind.make(driver === "codex" ? "codex" : "claudeAgent"),
          ...(credit ? { source: "nodex" } : {}),
        };
        const selection = { instanceId, model };
        const declarations = {
          [instanceId]: {
            driver: provider.driver,
            ...(credit ? { source: "nodex" as const } : {}),
            config: {},
          },
        };
        const owner = yield* makePolicy(DEFAULT_MODEL_POLICY, declarations);
        const entered = yield* Deferred.make<void>();
        let resume = () => {};
        const gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const prepare = Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Effect.promise(() => gate);
        });
        sdk.query.mockClear();
        sdk.prepare =
          driver === "codex"
            ? async () => {}
            : async () => {
                Deferred.doneUnsafe(entered, Effect.void);
                await gate;
              };
        return yield* Effect.gen(function* () {
          const raw =
            driver === "codex"
              ? yield* makeCodexTextGeneration(
                  Schema.decodeSync(CodexSettings)({
                    enabled: true,
                    setupMode: "existing",
                    binaryPath,
                  }),
                  { PATH: process.env.PATH },
                  prepare.pipe(Effect.as([])),
                )
              : yield* makeClaudeTextGeneration(
                  Schema.decodeSync(ClaudeSettings)({ enabled: true, binaryPath }),
                  { PATH: process.env.PATH },
                  Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
                );
          const admission = owner.assert(selection, "person").pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "generateStructured",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const facade = yield* TextGeneration.make.pipe(
            Effect.provide(
              Layer.mock(ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed({ textGeneration: raw } as ProviderInstance),
              }),
            ),
          );
          const request = (credit ? facade : raw).generateStructured!({
            cwd: home,
            prompt: "Fake peer only",
            modelSelection: selection,
            outputSchema: { type: "object" },
            ...(driver === "claude-sdk"
              ? { images: [{ mediaType: "image/png" as const, data: "AQID" }] }
              : {}),
          }).pipe(Effect.provideService(TextGenerationAdmission, admission));
          const task = yield* request.pipe(Effect.result, Effect.forkScoped);
          try {
            yield* Deferred.await(entered);
            yield* owner.replace({
              policy: setModelOn(DEFAULT_MODEL_POLICY, provider, model, false),
              providers: {
                [instanceId]: {
                  driver: provider.driver,
                  ...(credit ? { source: "nodex" as const } : {}),
                  config: {},
                },
              },
            });
            expect(yield* owner.assert(selection, "person").pipe(Effect.flip)).toMatchObject({
              code: "model_off",
            });
            resume();
            const result = yield* Fiber.join(task);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(String(result.failure)).toContain("off in Settings");
            expect(yield* fs.exists(marker)).toBe(false);
            expect(sdk.query).not.toHaveBeenCalled();
          } finally {
            resume();
          }
        }).pipe(
          Effect.provideService(RuntimeModelPolicy, owner),
          Effect.provide(ServerConfig.layerTest(home, { prefix: "nodex-model-policy-race-" })),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.live("switching off a running credit utility waits for its native process cleanup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-policy-active-utility-" });
    const binaryPath = `${home}/fake-cli.cjs`;
    yield* fs.writeFileString(
      binaryPath,
      `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(home + "/started")}, 'started'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(home + "/stopped")}, 'stopped'); process.exit(0); }); setInterval(() => {}, 1000);\n`,
    );
    yield* fs.chmod(binaryPath, 0o700);
    const selection = {
      instanceId: ProviderInstanceId.make("nodex_codex_test"),
      model: "gpt-6.1-sol",
    };
    const owner = yield* makePolicy(DEFAULT_MODEL_POLICY, {});
    return yield* Effect.gen(function* () {
      const raw = yield* makeCodexTextGeneration(
        Schema.decodeSync(CodexSettings)({ enabled: true, setupMode: "existing", binaryPath }),
        { PATH: process.env.PATH },
        Effect.succeed([]),
      );
      const generation = yield* TextGeneration.make.pipe(
        Effect.provide(
          Layer.mock(ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed({ textGeneration: raw } as ProviderInstance),
          }),
        ),
      );
      const task = yield* generation.generateStructured!({
        cwd: home,
        prompt: "Fake only",
        modelSelection: selection,
        outputSchema: { type: "object" },
      }).pipe(Effect.result, Effect.forkScoped);
      yield* fs
        .exists(`${home}/started`)
        .pipe(
          Effect.repeat({ until: (started) => started, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("5 seconds"),
        );
      yield* owner.replace({
        policy: setModelOn(
          DEFAULT_MODEL_POLICY,
          { instanceId: selection.instanceId, driver: "codex" },
          selection.model,
          false,
        ),
        providers: {},
      });
      const result = yield* Fiber.join(task);
      expect(result._tag).toBe("Failure");
      expect(yield* fs.exists(`${home}/stopped`)).toBe(true);
    }).pipe(
      Effect.provideService(RuntimeModelPolicy, owner),
      Effect.provide(ServerConfig.layerTest(home, { prefix: "nodex-model-policy-active-" })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
