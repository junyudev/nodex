import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { make } from "./NativeSessionHistory";
import { NativePromptImages } from "./NativePromptImages";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ClaudeSdk } from "../platform/node/ClaudeSdk";
import { OpenCodeSdk, type OpenCodeNativeMessage } from "../platform/node/OpenCodeSdk";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import {
  openCodeUserMessage,
  openCodeAssistantMessage,
} from "./opencode/OpenCodeHistory.test-fixtures";

const claudePrompt = (text = "Saved prompt"): SessionMessage => ({
  type: "user",
  uuid: "user",
  session_id: "native",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  parent_agent_id: null,
});
const fixture = (
  backend: "claude" | "opencode" = "claude",
  messages: readonly SessionMessage[] = [claudePrompt()],
) =>
  Effect.gen(function* () {
    let sessionId = "native";
    let cwd = "/original";
    let revision = "1";
    const reads: unknown[] = [];
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let held = false;
    let acquired = 0;
    let closed = 0;
    let openMessages: readonly OpenCodeNativeMessage[] = [
      openCodeUserMessage("parent", "Original", 1, "native"),
      openCodeAssistantMessage("child", "parent", "Response", 2, "native"),
    ];
    const port = yield* make.pipe(
      Effect.provide(mainConfigLayer()),
      Effect.provideService(ProjectWorkspace, {
        getThread: () =>
          Effect.succeed({
            threadId: "thread",
            cwd,
            backendBinding: { kind: backend, instanceConfigId: "profile" },
          }),
        readThreadBackendSession: () =>
          Effect.succeed({
            backendBinding: { kind: backend, instanceConfigId: "profile" },
            backendSessionId: sessionId,
            nativeHome: "/account",
            nativeState: null,
          }),
      } as never),
      Effect.provideService(ApplicationSettings, {
        snapshot: () => Effect.succeed({ revision }),
        claudeLaunchConfiguration: () =>
          Effect.succeed({
            instance: { id: "profile", configDirectory: "/account" },
            environment: {},
          }),
        openCodeLaunchConfiguration: () =>
          Effect.succeed({
            instance: { binaryPath: "/opencode", serverUrl: null },
            profileDirectory: "/account",
            environment: {},
          }),
      } as never),
      Effect.provideService(ClaudeSdk, {
        nativeHome: () => Effect.succeed("/account"),
        discover: () => Effect.die("History cannot open a Query"),
        historyPage: (
          input: Parameters<ClaudeSdk["Service"]["historyPage"]>[0],
          page: Parameters<ClaudeSdk["Service"]["historyPage"]>[1],
        ) =>
          Effect.gen(function* () {
            reads.push({ input, page });
            if (held) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return { messages, before: "older", hasMore: true };
          }),
        historyImage: () => Effect.succeed({ mediaType: "image/png", data: "eA==" }),
        historyToolOutput: () =>
          Effect.succeed({ text: "Exact output", originalBytes: 12, truncated: false }),
      } as never),
      Effect.provideService(OpenCodeSdk, {
        open: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired += 1;
              return {
                history: (nativeSessionId: string, page: unknown) =>
                  Effect.sync(() => {
                    reads.push({ nativeSessionId, page });
                    return { messages: openMessages, cursor: "older", hasMore: true };
                  }),
                message: (nativeSessionId: string, messageId: string) =>
                  Effect.sync(() => {
                    reads.push({ nativeSessionId, messageId });
                    return openCodeUserMessage("parent", "Original", 1, "native");
                  }),
              };
            }),
            () =>
              Effect.sync(() => {
                closed += 1;
              }),
          ),
      } as never),
      Effect.provideService(NativePromptImages, {
        materialize: () => Effect.succeed("nodex://assets/image"),
      } as never),
    );
    return {
      port,
      reads,
      hold: () => {
        held = true;
      },
      entered: Deferred.await(entered),
      release: Deferred.succeed(release, undefined),
      changeSession: () => {
        sessionId = "replacement";
      },
      changeCwd: () => {
        cwd = "/replacement";
      },
      changeSettings: () => {
        revision = "2";
      },
      setOpenMessages: (messages: readonly OpenCodeNativeMessage[]) => {
        openMessages = messages;
      },
      lifetime: () => ({ acquired, closed }),
    };
  });

it.effect("reads one native page without acquiring an execution Query and keeps its cursor", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f.port.read({ threadId: "thread", before: "boundary", limit: 50 });
    assert.equal(result.sessionId, "native");
    assert.equal(result.status, "closed");
    assert.equal(result.turns[0]?.promptText, "Saved prompt");
    assert.deepInclude(result.history, { cursor: "older", hasOlder: true, windowSize: 50 });
    assert.deepNestedInclude(f.reads[0], {
      "input.sessionId": "native",
      "input.cwd": "/original",
      "page.before": "boundary",
      "page.limit": 50,
    });
    assert.equal((yield* f.port.inspect("thread")).nativeSessionId, "native");
  }),
);

for (const change of ["changeSession", "changeCwd", "changeSettings"] as const)
  it.effect(`rejects history changed by ${change} while native data is loading`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.hold();
        const result = yield* f.port
          .read({ threadId: "thread" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* f.entered;
        f[change]();
        yield* f.release;
        const error = yield* Fiber.join(result);
        assert.instanceOf(error, Error);
        assert.include(error.message, "changed");
      }),
    ),
  );

it.effect("bounds previews and rejects an oversized or foreign native page", () =>
  Effect.gen(function* () {
    const f = yield* fixture("claude", [claudePrompt("界".repeat(100000))]);
    const result = yield* f.port.read({ threadId: "thread" });
    assert.isAtMost(Buffer.byteLength(result.turns[0]!.promptText!, "utf8"), 8192);
    assert.isAtMost(Buffer.byteLength(JSON.stringify(result), "utf8"), 1024 * 1024);
    const foreign = yield* fixture("claude", [{ ...claudePrompt(), session_id: "foreign" }]);
    assert.equal((yield* Effect.result(foreign.port.read({ threadId: "thread" })))._tag, "Failure");
    const pressure = yield* fixture(
      "claude",
      Array.from({ length: 2049 }, () => claudePrompt()),
    );
    assert.equal(
      (yield* Effect.result(pressure.port.read({ threadId: "thread" })))._tag,
      "Failure",
    );
    for (const limit of [0, 51, 1.5])
      assert.equal(
        (yield* Effect.result(f.port.read({ threadId: "thread", limit })))._tag,
        "Failure",
      );
  }),
);

it.effect(
  "hydrates an OpenCode response's exact parent within one closed metadata connection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("opencode");
      f.setOpenMessages([openCodeAssistantMessage("child", "parent", "Response", 2, "native")]);
      const result = yield* f.port.read({ threadId: "thread", limit: 1 });
      assert.equal(result.turns[0]?.promptText, "Original");
      assert.isTrue(
        result.turns[0]?.updates.some(
          (update) => update.kind === "message" && update.text === "Response",
        ),
      );
      assert.deepEqual(f.reads, [
        { nativeSessionId: "native", page: { limit: 1 } },
        { nativeSessionId: "native", messageId: "parent" },
      ]);
      assert.deepEqual(f.lifetime(), { acquired: 1, closed: 1 });
      f.setOpenMessages([openCodeUserMessage("foreign", "Wrong", 1, "foreign")]);
      assert.equal((yield* Effect.result(f.port.read({ threadId: "thread" })))._tag, "Failure");
      assert.deepEqual(f.lifetime(), { acquired: 2, closed: 2 });
    }),
);

it.effect("lazy native details require the original Session descriptor", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const input = {
      threadId: "thread",
      expectedSessionId: "native",
      nativeMessageId: "user",
      index: 0,
    };
    assert.equal(yield* f.port.image(input), "nodex://assets/image");
    assert.equal((yield* f.port.toolOutput({ ...input, toolUseId: "tool" })).text, "Exact output");
    f.changeSession();
    assert.equal((yield* Effect.result(f.port.image(input)))._tag, "Failure");
    assert.equal(
      (yield* Effect.result(f.port.toolOutput({ ...input, toolUseId: "tool" })))._tag,
      "Failure",
    );
  }),
);
