import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ClaudeSettings, ProviderSessionId, ThreadId } from "@nodex/runtime-contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@nodex/provider-core/server/McpProviderSessions";
import * as Claude from "./ClaudeAdapterV2.ts";
import * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import { available } from "../../provider/ClaudeSessionHistory.ts";

it.live(
  "only rejects native resume for confirmed unavailable transcripts, preserving unverified history",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-claude-resume-" });
        let native = 0;
        const runner: Claude.ClaudeAgentSdkQueryRunnerShape = {
          allocateSessionId: Effect.sync(() => `native-${++native}`),
          sessionHistoryAvailable: (input) =>
            available(input).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.mapError(
                (cause) => new Claude.ClaudeAgentSdkQueryRunnerError({ method: "history", cause }),
              ),
            ),
          open: () => Effect.die("Resume preflight must not start a native query"),
          forkSession: () => Effect.die("unused"),
          deleteSession: () => Effect.void,
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        };
        const adapter = yield* Claude.makeClaudeAdapterV2({
          instanceId: Claude.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: yield* Schema.decodeUnknownEffect(ClaudeSettings)({}),
          environment: { CLAUDE_CONFIG_DIR: home },
          attachmentsDir: home,
          fileSystem: fs,
          path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: runner,
        });
        const threadId = ThreadId.make("thread:claude-resume");
        const modelSelection = {
          instanceId: Claude.CLAUDE_DEFAULT_INSTANCE_ID,
          model: "claude-sonnet-4-6",
        };
        const runtimePolicy = {
          cwd: home,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
        };
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("session:resume"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const missing = yield* runtime
          .resumeThread({ threadId, providerThread, modelSelection, runtimePolicy })
          .pipe(Effect.result);
        expect(missing._tag).toBe("Failure");
        if (missing._tag === "Failure") {
          expect(Schema.is(ProviderAdapter.ProviderAdapterResumeThreadError)(missing.failure)).toBe(
            true,
          );
          expect(missing.failure).toMatchObject({
            retryable: false,
            cause: { _tag: "ClaudeNativeSessionUnavailableError" },
          });
        }
        const project = path.join(home, "projects", "workspace");
        yield* fs.makeDirectory(project, { recursive: true });
        const transcript = path.join(project, "native-1.jsonl");
        yield* fs.writeFileString(transcript, "malformed");
        // Unreadable history keeps native resume, allowing the CLI to report its actual startup error.
        const unverified = yield* runtime.resumeThread({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
        });
        expect(unverified.nativeThreadRef).toEqual(providerThread.nativeThreadRef);
        yield* fs.writeFileString(transcript, '{"type":"user"}\n');
        expect(
          (yield* runtime.resumeThread({ threadId, providerThread, modelSelection, runtimePolicy }))
            .nativeThreadRef,
        ).toEqual(providerThread.nativeThreadRef);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
);
