import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@nodex/runtime-contracts";
import { TextGenerationAdmission } from "@nodex/provider-core/server/textGenerationPolicy";
import * as TestProviderHost from "@nodex/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { OpenCode2Server, type OpenCode2Connection } from "./OpenCode2Server.ts";
import { make } from "./textGeneration.ts";

it.effect("rechecks policy after session preparation before an OpenCode 2 prompt", () =>
  Effect.gen(function* () {
    const preparing = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let on = true;
    let prompts = 0;
    let removed = false;
    const connection = {
      url: "http://test.invalid",
      version: "2",
      external: false,
      events: Effect.succeed(Stream.never),
      client: {
        session: {
          create: () =>
            Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.as({ id: "utility" }),
            ),
          prompt: () =>
            Effect.sync(() => {
              prompts++;
            }),
          remove: () =>
            Effect.sync(() => {
              removed = true;
            }),
        },
      },
    } as unknown as OpenCode2Connection;
    const generation = yield* make().pipe(
      Effect.provideService(OpenCode2Server, {
        withConnection: (use) => use(connection),
      }),
    );
    const fiber = yield* generation
      .generateCommitMessage({
        cwd: "/test",
        branch: "test",
        stagedSummary: "file",
        stagedPatch: "diff",
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/model" },
      })
      .pipe(
        Effect.provideService(
          TextGenerationAdmission,
          Effect.suspend(() =>
            on
              ? Effect.void
              : Effect.fail(
                  new TextGenerationError({
                    operation: "commit-message",
                    detail: "Model is off",
                    cause: { code: "model_off", message: "Model is off", retryable: false },
                  }),
                ),
          ),
        ),
        Effect.result,
        Effect.forkScoped,
      );
    yield* Deferred.await(preparing);
    on = false;
    yield* Deferred.succeed(resume, undefined);
    const result = yield* Fiber.join(fiber);
    expect(result._tag).toBe("Failure");
    expect(prompts).toBe(0);
    expect(removed).toBe(true);
  }).pipe(
    Effect.provide(TestProviderHost.layer()),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
