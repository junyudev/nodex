/* This scoped test provides the callback runtime at its entry point. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { produce, type Draft } from "immer";
import { make } from "./CodexMainConversationEdit";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { layer as callbacks } from "../app/ScopedCallbackRuntime";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import type { ConversationFollowerTurnStart } from "../../shared/codex-thread-follower-request";

const makeEditFixture = Effect.fnUntraced(function* (hostId = "local") {
  let state = produce(
    conversationFixture("thread", [turnFixture("message"), turnFixture("automatic")]),
    (draft) => {
      draft.turns[0]!.params.input = [
        { type: "text", text: "original", text_elements: [] },
        { type: "localImage", path: "/image.png" },
      ];
      draft.turns[1]!.params.input = [];
      replaceCanonicalHistoryDraft(draft, draft.turns, false);
    },
  );
  const calls: string[] = [];
  let admitted: ConversationFollowerTurnStart | undefined;
  const manager = {
    hostId,
    generation: 1,
    assertCurrent: () => {},
    stream: { getRole: () => ({ role: "owner" }) },
  } as unknown as MainConversationManager;
  const service = yield* make.pipe(
    Effect.provideService(TemporaryAssets, {
      resolveAssetPath: (fileName: string) => {
        assert.strictEqual(fileName, "shot.png");
        return `/managed-images/${fileName}`;
      },
    } as TemporaryAssets["Service"]),
    Effect.provideService(CodexMainConversationManagers, {
      get: () => Effect.succeed(manager),
    } as unknown as CodexMainConversationManagers["Service"]),
    Effect.provideService(CodexMainConversationSettings, {
      awaitCurrent: () =>
        Effect.sync(() => {
          calls.push("settings");
        }),
    } as unknown as CodexMainConversationSettings["Service"]),
    Effect.provideService(ConversationEntityMap, {
      current: () => ({
        readCanonicalState: () => state,
        mutateCanonicalState: (recipe: (draft: Draft<typeof state>) => void) => {
          state = produce(state, recipe);
        },
      }),
    } as unknown as ConversationEntityMap["Service"]),
    Effect.provideService(CodexGateway, {
      requestOnHost: (_host: string, method: string, params: unknown) =>
        Effect.sync(() => {
          calls.push(method);
          assert.strictEqual(method, "thread/revert");
          assert.deepEqual(params, { threadId: "thread", beforeTurnId: "message" });
          return {
            thread: {
              id: "thread",
              sessionId: "new-session",
              path: null,
              cwd: "/returned",
              status: { type: "idle" },
            },
            turnsBackwardsCursor: "retained",
            itemsBackwardsCursor: null,
          };
        }),
    } as unknown as CodexGateway["Service"]),
    Effect.provideService(CodexAppServerCapabilities, {
      forHost: () =>
        Effect.succeed(
          createCodexAppServerCapabilitySnapshot({
            hostId,
            generation: 1,
            userAgent: "0.153.0",
          }),
        ),
    } as unknown as CodexAppServerCapabilities["Service"]),
    Effect.provideService(CodexTurnCommands, {
      prepareNativeStart: (
        _id: string,
        _prompt: string,
        overrides: Parameters<CodexTurnCommands["Service"]["prepareNativeStart"]>[2],
        request: TurnStartParams,
        context: ConversationFollowerTurnStart["context"],
      ) =>
        Effect.sync(() => {
          calls.push("prepare");
          assert.deepEqual(overrides?.preparedPrompt?.inputItems, request.input);
          assert.deepEqual(overrides?.preparedPrompt?.pendingInputItems, request.input);
          admitted = { request: { ...request, clientUserMessageId: "edit" }, context };
          return admitted;
        }),
      inspectPreparedNativeStart: (operation: ConversationFollowerTurnStart) =>
        Effect.succeed({ request: operation.request }),
      executePreparedNativeStart: () =>
        Effect.sync(() => {
          calls.push("start");
          return {};
        }),
      releasePreparedNativeStart: () => {
        calls.push("release");
      },
    } as unknown as CodexTurnCommands["Service"]),
  );
  return {
    service,
    calls,
    readState: () => state,
    readAdmitted: () => admitted,
  };
});

for (const { name, message, writtenImages, expectedText, expectedImages } of [
  {
    name: "plain text",
    message: "edited",
    writtenImages: undefined,
    expectedText: "edited",
    expectedImages: [],
  },
  {
    name: "written images",
    message:
      "![shot](/tmp/x.png)\n\n![asset](nodex://assets/shot.png)\n\n![file](file:///tmp/my%20shot.png)\n\n![library](nodex://files/library-shot)",
    writtenImages: [
      { source: "/tmp/x.png" },
      { source: "nodex://assets/shot.png" },
      { source: "file:///tmp/my%20shot.png" },
      { source: "data:image/png;base64,AQID" },
    ],
    expectedText:
      "[Image #2] (caption: shot; path: /tmp/x.png)\n\n[Image #3] (caption: asset)\n\n[Image #4] (caption: file; path: /tmp/my shot.png)\n\n[Image #5] (caption: library)",
    expectedImages: [
      { type: "localImage", path: "/tmp/x.png" },
      { type: "localImage", path: "/managed-images/shot.png" },
      { type: "localImage", path: "/tmp/my shot.png" },
      { type: "image", url: "data:image/png;base64,AQID" },
    ],
  },
] as const)
  it.effect(
    `Main edit reverts retained identities and admits prepared native input and context (${name})`,
    () =>
      Effect.gen(function* () {
        const { service, calls, readState, readAdmitted } = yield* makeEditFixture();
        yield* service.edit("local", "thread", {
          turnId: "message",
          message,
          writtenImages,
          writingBlockContextPrepared: true,
        });
        assert.deepEqual(calls, ["settings", "thread/revert", "prepare", "start", "release"]);
        const admitted = readAdmitted();
        assert.deepEqual(admitted?.request.input, [
          { type: "text", text: expectedText, text_elements: [] },
          { type: "localImage", path: "/image.png" },
          ...expectedImages,
        ]);
        assert.strictEqual(admitted?.request.cwd, "/returned");
        assert.strictEqual(admitted?.context?.writingBlockContextPrepared, true);
        assert.strictEqual(residentConversationTurns(readState()).length, 0);
      }).pipe(Effect.provide(callbacks)),
  );

it.effect("Main edit preserves remote history when a managed image has no bytes", () =>
  Effect.gen(function* () {
    const { service, calls, readState, readAdmitted } = yield* makeEditFixture("devbox");
    const originalState = readState();
    const originalTurns = structuredClone(residentConversationTurns(originalState));
    const options = {
      turnId: "message",
      message: "Compare ![asset](nodex://assets/shot.png)",
      writingBlockContextPrepared: true,
    };
    const error = yield* service
      .edit("devbox", "thread", {
        ...options,
        writtenImages: [{ source: "nodex://assets/shot.png" }],
      })
      .pipe(Effect.flip);

    assert.strictEqual(error.hostId, "devbox");
    assert.strictEqual(
      String(error.cause),
      "Error: A managed image reaches another host only as its bytes",
    );
    assert.deepEqual(calls, ["settings"]);
    assert.isUndefined(readAdmitted());
    assert.strictEqual(readState(), originalState);
    assert.deepEqual(residentConversationTurns(readState()), originalTurns);

    yield* service.edit("devbox", "thread", {
      ...options,
      writtenImages: [{ source: "data:image/png;base64,AQID" }],
    });

    assert.deepEqual(calls, [
      "settings",
      "settings",
      "thread/revert",
      "prepare",
      "start",
      "release",
    ]);
    assert.deepEqual(readAdmitted()?.request.input, [
      { type: "text", text: "Compare [Image #2] (caption: asset)", text_elements: [] },
      { type: "localImage", path: "/image.png" },
      { type: "image", url: "data:image/png;base64,AQID" },
    ]);
    assert.strictEqual(residentConversationTurns(readState()).length, 0);
  }).pipe(Effect.provide(callbacks)),
);
