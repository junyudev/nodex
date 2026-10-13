/* Scoped queue tests provide a single boundary fixture. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  CODEX_APP_SERVER_DEVELOPMENT_CAPABILITY_FLAGS,
} from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexMainConversationManagers,
  MainConversationManagerError,
} from "./CodexMainConversationManagers";
import { CodexInputAssets } from "./CodexInputAssets";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ConversationEntityMap, live as entitiesLayer } from "./internal/ConversationEntityMap";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import {
  conversationTurnDraft,
  residentConversationTurnEntries,
} from "../../shared/codex-conversation-state/codex-turn-mutation";
import { buildCodexSteeringCompareKey } from "../../shared/codex-conversation-state/codex-steering-compare";
import type { QueuedSubmission } from "@nodex/codex-app-server-protocol/v2";
import { make } from "./CodexQueuedFollowUps";
import type { CodexQueuedMessageState } from "../../shared/codex-queued-message";
import type { QueuedMessageRole } from "../../shared/codex-queued-message-coordinator";
import {
  createCodexQueuedMessageDeliveryReceipt,
  queuedMessagePromptInput,
  readCodexQueuedMessageDeliveryReceipt,
} from "../../shared/codex-queued-message";
import { prepareUntrustedAppInput } from "../../shared/codex-untrusted-app-input";

const message = (id: string) => ({
  id,
  cwd: "/repo",
  context: {
    prompt: "captured",
    fileAttachments: [],
    addedFiles: [],
    commentAttachments: [],
    imageAttachments: [],
    mcpAppModelContextAttachments: [{ widget: { arbitrary: [1, 2] } }],
  },
});
const fixture = (
  initial: CodexQueuedMessageState = {},
  options: {
    hostId?: string;
    native?: QueuedSubmission[];
    pageSize?: number;
    threadQueue?: boolean;
    ephemeral?: boolean;
    onRead?: () => Effect.Effect<void>;
    onCapabilities?: () => Effect.Effect<void>;
    onNative?: () => Effect.Effect<void>;
    stalledCursor?: boolean;
    deleteFails?: boolean;
    managerFails?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    let state = initial;
    let role: QueuedMessageRole = { role: "owner" };
    let generation = 1;
    const hostId = options.hostId ?? "local";
    const scope = yield* Scope.Scope;
    const entities = Context.get(
      yield* Layer.buildWithScope(entitiesLayer, scope),
      ConversationEntityMap,
    );
    const canonical = {
      ...conversationFixture("thread"),
      hostId,
      ephemeral: options.ephemeral ?? false,
    };
    entities.entity("thread").installFollowerCanonicalState(canonical);
    let native = [...(options.native ?? [])];
    let deleteFails = options.deleteFails ?? false;
    const nativeRequests: {
      hostId: string;
      method: string;
      params: Record<string, unknown>;
      scheduling: unknown;
    }[] = [];
    const broadcasts: unknown[] = [];
    const followerRequests: unknown[] = [];
    const events: unknown[] = [];
    const manager = {
      hostId,
      get generation() {
        return generation;
      },
      assertCurrent: (expected?: number) => {
        if (expected !== undefined && generation !== expected)
          throw new Error("Connection changed");
      },
      stream: { getRole: () => role },
      coordination: {
        threadQueuedFollowUpsChanged: async (value: unknown) => {
          broadcasts.push(value);
        },
        requestThreadFollower: async (value: unknown) => {
          followerRequests.push(value);
          return { resultType: "success", result: { ok: true } };
        },
      },
      subscribeQueuedMessages: () => ({ [Symbol.dispose]() {} }),
      onDispose: () => () => {},
    };
    const service = yield* make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: () =>
            Effect.suspend(() => options.onRead?.() ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => ({ value: { kind: "queued_message_state", state } })),
              ),
            ),
          apply: (input: { intent: { kind: string; state: CodexQueuedMessageState } }) =>
            Effect.sync(() => {
              assert.strictEqual(input.intent.kind, "set_queued_message_state");
              state = structuredClone(input.intent.state);
              return {};
            }),
        },
      } as unknown as CoreModules["Service"]),
      Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed(hostId) }),
      Effect.provideService(CodexMainConversationManagers, {
        get: () =>
          options.managerFails
            ? Effect.fail(
                new MainConversationManagerError({ hostId, cause: new Error("Manager retired") }),
              )
            : Effect.succeed(manager),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexGateway, {
        requestOnHost: (
          selectedHost: string,
          method: string,
          params: Record<string, unknown>,
          scheduling: unknown,
        ) =>
          Effect.gen(function* () {
            nativeRequests.push({ hostId: selectedHost, method, params, scheduling });
            yield* options.onNative?.() ?? Effect.void;
            if (method === "thread/queue/delete") {
              if (deleteFails) return { deleted: false };
              const previous = native.length;
              native = native.filter((item) => item.id !== params.queuedSubmissionId);
              return { deleted: native.length !== previous };
            }
            assert.strictEqual(method, "thread/queue/list");
            const start = params.cursor == null ? 0 : Number(params.cursor);
            const end = start + (options.pageSize ?? 100);
            return {
              data: native.slice(start, end),
              nextCursor: options.stalledCursor ? "0" : end < native.length ? String(end) : null,
            };
          }),
      } as unknown as CodexGateway["Service"]),
      Effect.provideService(CodexAppServerCapabilities, {
        forHost: () =>
          (options.onCapabilities?.() ?? Effect.void).pipe(
            Effect.as({
              hostId,
              generation: 1,
              sourceEpoch: "endpoint-1",
              userAgent: "fixture",
              version: "0.0.0",
              nativeAppTools: false,
              flags: {
                ...CODEX_APP_SERVER_DEVELOPMENT_CAPABILITY_FLAGS,
                threadQueue: options.threadQueue ?? true,
              },
            }),
          ),
        forThread: () => Effect.die("unused"),
        isCurrent: (snapshot) => Effect.succeed(snapshot.generation === generation),
      }),
      Effect.provideService(CodexInputAssets, {
        retainPrepared: (_thread, _id, prepared) => Effect.succeed(prepared),
        retainCaptured: (_thread, _id, input) => Effect.succeed(input),
      }),
      Effect.provideService(CodexTurnPresentation, {} as CodexTurnPresentation["Service"]),
      Effect.provideService(CodexApplicationEventHub, {
        events: Stream.never,
        publish: (event) => {
          events.push(event);
        },
      }),
      Effect.provideService(ConversationEntityMap, entities),
    );
    return {
      service,
      broadcasts,
      followerRequests,
      events,
      state: () => state,
      native: () => native,
      setDeleteFails: (next: boolean) => {
        deleteFails = next;
      },
      nativeRequests,
      entities,
      reconnect: () => {
        generation++;
      },
      setRole: (next: QueuedMessageRole) => {
        role = next;
      },
    };
  });

const nativeSubmission = (id: string): QueuedSubmission => ({
  id,
  input: [{ type: "text", text: `native ${id}`, text_elements: [] }],
  clientUserMessageId: `client-${id}`,
});

it.effect(
  "an owner removes only the selected captured local message without touching native order",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const one = {
          ...message("one"),
          submissionOptions: { executionHostId: "remote", serviceTier: "fast" as const },
        };
        const two = message("two");
        const f = yield* fixture(
          { thread: [one, two], unrelated: [message("other")] },
          { hostId: "remote", native: [nativeSubmission("one")] },
        );
        assert.isTrue(yield* f.service.removeAsOwner("remote", "thread", "one"));
        assert.deepEqual(f.state(), { thread: [two], unrelated: [message("other")] });
        assert.deepEqual(f.native(), [nativeSubmission("one")]);
        assert.deepEqual(f.nativeRequests, []);
        assert.deepEqual(f.broadcasts, [
          { hostId: "remote", conversationId: "thread", messages: [two] },
        ]);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "native removal and paginated clear retain selected host, generation and separate local authority",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(
          { thread: [message("local")], unrelated: [message("other")] },
          {
            hostId: "remote",
            native: [nativeSubmission("a"), nativeSubmission("b"), nativeSubmission("c")],
            pageSize: 1,
          },
        );
        assert.isTrue(yield* f.service.removeAsOwner("remote", "thread", "b"));
        assert.deepEqual(f.state().thread, [message("local")]);
        assert.isFalse(yield* f.service.removeAsOwner("remote", "thread", "missing"));
        assert.isTrue(yield* f.service.clearAsOwner("remote", "thread"));
        assert.deepEqual(f.native(), []);
        assert.deepEqual(f.state(), { unrelated: [message("other")] });
        assert.deepEqual(
          f.nativeRequests.map(({ method, params }) => [method, params]),
          [
            ["thread/queue/delete", { threadId: "thread", queuedSubmissionId: "b" }],
            ["thread/queue/delete", { threadId: "thread", queuedSubmissionId: "missing" }],
            ["thread/queue/list", { threadId: "thread", cursor: null }],
            ["thread/queue/list", { threadId: "thread", cursor: "1" }],
            ["thread/queue/delete", { threadId: "thread", queuedSubmissionId: "a" }],
            ["thread/queue/delete", { threadId: "thread", queuedSubmissionId: "c" }],
          ],
        );
        for (const request of f.nativeRequests) {
          assert.strictEqual(request.hostId, "remote");
          assert.deepEqual(request.scheduling, { expectedHostId: "remote", expectedGeneration: 1 });
        }
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

for (const gate of ["capability", "ephemeral"] as const) {
  it.effect(`disabled native queues stay local for ${gate}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(
          { thread: [message("local")] },
          {
            threadQueue: gate !== "capability",
            ephemeral: gate === "ephemeral",
            native: [nativeSubmission("a")],
          },
        );
        assert.isFalse(yield* f.service.removeAsOwner("local", "thread", "a"));
        assert.isTrue(yield* f.service.clearAsOwner("local", "thread"));
        assert.deepEqual(f.state(), {});
        assert.deepEqual(f.nativeRequests, []);
        assert.deepEqual(f.native(), [nativeSubmission("a")]);
      }),
    ).pipe(Effect.provide(callbackLayer)),
  );
}

for (const invalidation of ["owner-incarnation", "connection", "entity", "host"] as const) {
  it.effect(`a queue control rejects stale ${invalidation} after capability admission`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const f = yield* fixture(
          { thread: [message("local")] },
          {
            native: [nativeSubmission("a")],
            onCapabilities: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
          },
        );
        const running = yield* f.service.clearAsOwner("local", "thread").pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (invalidation === "owner-incarnation") {
          f.setRole({ role: "follower", ownerClientId: "other" });
          f.setRole({ role: "owner" });
        }
        if (invalidation === "connection") f.reconnect();
        if (invalidation === "entity") {
          yield* f.entities.retire("thread");
          f.entities.entity("thread").installFollowerCanonicalState(conversationFixture("thread"));
        }
        if (invalidation === "host")
          f.entities
            .current("thread")!
            .installFollowerCanonicalState({ ...conversationFixture("thread"), hostId: "remote" });
        yield* Deferred.succeed(released, undefined);
        assert.strictEqual((yield* Fiber.await(running))._tag, "Failure");
        assert.deepEqual(f.nativeRequests, []);
        assert.deepEqual(f.state(), { thread: [message("local")] });
        assert.deepEqual(f.broadcasts, []);
      }),
    ).pipe(Effect.provide(callbackLayer)),
  );
}

it.effect(
  "a stalled native cursor fails without clearing local captures or repeating deletes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(
          { thread: [message("local")] },
          { native: [nativeSubmission("a")], stalledCursor: true },
        );
        assert.strictEqual(
          (yield* f.service.clearAsOwner("local", "thread").pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(f.nativeRequests.length, 2);
        assert.deepEqual(f.native(), [nativeSubmission("a")]);
        assert.deepEqual(f.state(), { thread: [message("local")] });
        assert.deepEqual(f.broadcasts, []);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect("clear retains whole captures edited or added while native deletion is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const f = yield* fixture(
        { thread: [message("one"), message("two")] },
        {
          native: [nativeSubmission("native")],
          onNative: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
        },
      );
      const running = yield* f.service.clearAsOwner("local", "thread").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const edited = {
        ...message("one"),
        context: { ...message("one").context, prompt: "edited during native await" },
      };
      const late = {
        ...message("late"),
        submission: createCodexQueuedMessageDeliveryReceipt(
          "local",
          message("late"),
          nativeSubmission("late").input,
          {
            stage: "outcome-unknown",
            method: "thread/queue/add",
            requestId: "physical-late-add",
          },
        ),
      };
      assert.isNotNull(readCodexQueuedMessageDeliveryReceipt(late));
      yield* f.service.writeMessageState({ thread: [edited, message("two"), late] });
      yield* Deferred.succeed(released, undefined);
      assert.isTrue(yield* Fiber.join(running));
      assert.deepEqual(f.state(), { thread: [edited, late] });
      assert.deepEqual(f.native(), []);
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "local storage revalidates the captured owner incarnation before committing its recipe",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        let reads = 0;
        const f = yield* fixture(
          { thread: [message("one")] },
          {
            onRead: () =>
              ++reads === 2
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(released)),
                  )
                : Effect.void,
          },
        );
        const running = yield* f.service
          .removeAsOwner("local", "thread", "one")
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        f.setRole({ role: "follower", ownerClientId: "next" });
        f.setRole({ role: "owner" });
        yield* Deferred.succeed(released, undefined);
        assert.strictEqual((yield* Fiber.await(running))._tag, "Failure");
        assert.deepEqual(f.state(), { thread: [message("one")] });
        assert.deepEqual(f.broadcasts, []);
        assert.deepEqual(f.events, []);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect("queue controls do not create a missing Thread authority", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.strictEqual(
        (yield* f.service.clearAsOwner("local", "missing").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(f.entities.current("missing"), null);
      assert.deepEqual(f.nativeRequests, []);
      assert.deepEqual(f.events, []);
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "accepted cleanup compares whole native values, preserves a new edit, and never delivers again",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const matched = nativeSubmission("matched");
        const old = nativeSubmission("edited");
        const edited = {
          ...old,
          input: [{ type: "text" as const, text: "new owner edit", text_elements: [] }],
        };
        const missing = nativeSubmission("missing");
        const f = yield* fixture(
          { thread: [message("local")] },
          { hostId: "remote", native: [edited, matched], pageSize: 1 },
        );
        f.entities.current("thread")!.mutateCanonicalState((draft) => {
          draft.unconfirmedServerQueueMessages = [old, matched, missing];
        }, 1);
        yield* f.service.reconcileAcceptedAsOwner("remote", "thread");
        assert.deepEqual(f.native(), [edited]);
        assert.strictEqual(
          f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
          undefined,
        );
        assert.deepEqual(f.state(), { thread: [message("local")] });
        assert.deepEqual(
          f.nativeRequests.map((request) => request.method),
          ["thread/queue/list", "thread/queue/list", "thread/queue/delete"],
        );
        assert.deepEqual(f.nativeRequests.at(-1)!.params, {
          threadId: "thread",
          queuedSubmissionId: "matched",
        });
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "failed accepted cleanup retains its exact receipt and retries only native deletion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receipt = nativeSubmission("accepted");
        const f = yield* fixture({}, { native: [receipt], deleteFails: true });
        f.entities.current("thread")!.mutateCanonicalState((draft) => {
          draft.unconfirmedServerQueueMessages = [receipt];
        }, 1);
        assert.strictEqual(
          (yield* f.service.reconcileAcceptedAsOwner("local", "thread").pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepEqual(
          f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
          [receipt],
        );
        f.setDeleteFails(false);
        yield* f.service.reconcileAcceptedAsOwner("local", "thread");
        assert.deepEqual(f.native(), []);
        assert.strictEqual(
          f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
          undefined,
        );
        assert.deepEqual(
          f.nativeRequests.map((request) => request.method),
          [
            "thread/queue/list",
            "thread/queue/delete",
            "thread/queue/list",
            "thread/queue/list",
            "thread/queue/delete",
          ],
        );
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect("accepted cleanup refuses a replacement owner after an outstanding native read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const receipt = nativeSubmission("accepted");
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const f = yield* fixture(
        {},
        {
          native: [receipt],
          onNative: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
        },
      );
      f.entities.current("thread")!.mutateCanonicalState((draft) => {
        draft.unconfirmedServerQueueMessages = [receipt];
      }, 1);
      const running = yield* f.service
        .reconcileAcceptedAsOwner("local", "thread")
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      f.setRole({ role: "follower", ownerClientId: "other" });
      f.setRole({ role: "owner" });
      yield* Deferred.succeed(released, undefined);
      assert.strictEqual((yield* Fiber.await(running))._tag, "Failure");
      assert.deepEqual(f.native(), [receipt]);
      assert.deepEqual(
        f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
        [receipt],
      );
      assert.deepEqual(
        f.nativeRequests.map((request) => request.method),
        ["thread/queue/list"],
      );
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "ordinary terminal cleanup runs inside its existing lane without starting or pausing local input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture({ thread: [message("local")] });
        f.entities.current("thread")!.mutateCanonicalState((draft) => {
          draft.unconfirmedServerQueueMessages = [nativeSubmission("already-removed")];
        }, 1);
        yield* f.entities.runCommand(
          "thread",
          f.service.acceptTerminalOutcomeInCurrentLane({ threadId: "thread", interrupted: false }),
        );
        assert.strictEqual(
          f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
          undefined,
        );
        assert.deepEqual(f.state(), { thread: [message("local")] });
        assert.deepEqual(
          f.nativeRequests.map((request) => request.method),
          ["thread/queue/list"],
        );
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "a follower queue replacement rejects owner reincarnation while loading captured state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const f = yield* fixture(
          { thread: [message("before")] },
          {
            onRead: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
          },
        );
        const running = yield* f.service
          .acceptFromFollower("thread", [message("stale")])
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        f.setRole({ role: "follower", ownerClientId: "new" });
        f.setRole({ role: "owner" });
        yield* Deferred.succeed(released, undefined);
        assert.strictEqual((yield* Fiber.await(running))._tag, "Failure");
        assert.deepEqual(f.state(), { thread: [message("before")] });
        assert.deepEqual(f.events, []);
        assert.deepEqual(f.broadcasts, []);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "failed ordinary terminal cleanup keeps recovery evidence without failing completion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receipt = nativeSubmission("accepted");
        const f = yield* fixture(
          { thread: [message("local")] },
          { native: [receipt], deleteFails: true },
        );
        f.entities.current("thread")!.mutateCanonicalState((draft) => {
          draft.unconfirmedServerQueueMessages = [receipt];
        }, 1);
        const terminal = yield* f.entities
          .runCommand(
            "thread",
            f.service.acceptTerminalOutcomeInCurrentLane({
              threadId: "thread",
              interrupted: false,
            }),
          )
          .pipe(Effect.result);
        assert.strictEqual(terminal._tag, "Success");
        assert.deepEqual(
          f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
          [receipt],
        );
        assert.deepEqual(f.state(), { thread: [message("local")] });
        f.setDeleteFails(false);
        yield* f.entities.runCommand(
          "thread",
          f.service.acceptTerminalOutcomeInCurrentLane({ threadId: "thread", interrupted: false }),
        );
        assert.strictEqual(
          f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
          undefined,
        );
        assert.deepEqual(f.native(), []);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "cleanup retires pending queue correlation before a real late user echo can restore its receipt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receipt = nativeSubmission("accepted");
        const f = yield* fixture({}, { native: [receipt] });
        const entity = f.entities.current("thread")!;
        entity.installFollowerCanonicalState(
          conversationFixture("thread", [turnFixture("active", "inProgress")]),
        );
        entity.mutateCanonicalState((draft) => {
          const turn = conversationTurnDraft(
            draft,
            residentConversationTurnEntries(draft)[0]!.address,
          )!;
          turn.items.push({
            type: "steeringUserMessage",
            id: "pending",
            targetTurnId: "active",
            targetTurnStartedAtMs: null,
            status: "pending",
            clientUserMessageId: receipt.clientUserMessageId,
            input: receipt.input,
            attachments: [],
            restoreMessage: { context: { commentAttachments: [] } },
            compareKey: buildCodexSteeringCompareKey(receipt.input, []),
            serverQueuedSubmission: receipt,
          });
          draft.unconfirmedServerQueueMessages = [receipt];
        }, 1);
        yield* f.service.reconcileAcceptedAsOwner("local", "thread");
        const readPending = () =>
          residentConversationTurnEntries(entity.readCanonicalState()!)[0]!.turn.items.find(
            (item) => item.id === "pending",
          );
        const cleaned = readPending();
        assert.strictEqual(cleaned?.type, "steeringUserMessage");
        if (cleaned?.type !== "steeringUserMessage")
          throw new Error("Steering correlation missing");
        assert.strictEqual(cleaned.serverQueuedSubmission, undefined);
        entity.commitProtocolNotification({
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread",
              turnId: "active",
              item: {
                type: "userMessage",
                id: "late-echo",
                clientId: receipt.clientUserMessageId,
                content: receipt.input,
              },
              completedAtMs: 3,
            },
          },
          observedAtMs: 3,
          createId: () => "00000000-0000-0000-0000-000000000000",
        });
        const accepted = readPending();
        assert.strictEqual(accepted?.type, "steeringUserMessage");
        if (accepted?.type !== "steeringUserMessage")
          throw new Error("Accepted steering correlation missing");
        assert.strictEqual(accepted.status, "accepted");
        assert.strictEqual(accepted.serverUserMessageId, "late-echo");
        assert.strictEqual(accepted.serverQueuedSubmission, undefined);
        assert.strictEqual(entity.readCanonicalState()!.unconfirmedServerQueueMessages, undefined);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "ordinary completion survives a retired cleanup manager while interruption retains its failure contract",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receipt = nativeSubmission("accepted");
        const f = yield* fixture({ thread: [message("local")] }, { managerFails: true });
        f.entities.current("thread")!.mutateCanonicalState((draft) => {
          draft.unconfirmedServerQueueMessages = [receipt];
        }, 1);
        const ordinary = yield* f.entities
          .runCommand(
            "thread",
            f.service.acceptTerminalOutcomeInCurrentLane({
              threadId: "thread",
              interrupted: false,
            }),
          )
          .pipe(Effect.result);
        assert.strictEqual(ordinary._tag, "Success");
        assert.deepEqual(
          f.entities.current("thread")!.readCanonicalState()!.unconfirmedServerQueueMessages,
          [receipt],
        );
        const interrupted = yield* f.entities
          .runCommand(
            "thread",
            f.service.acceptTerminalOutcomeInCurrentLane({ threadId: "thread", interrupted: true }),
          )
          .pipe(Effect.result);
        assert.strictEqual(interrupted._tag, "Failure");
        assert.deepEqual(f.state(), { thread: [message("local")] });
        assert.deepEqual(f.nativeRequests, []);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect("retains explicit visualization annotations across queue persistence and editing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const attachment: import("../../shared/codex-untrusted-app-input").CodexAppModelContextAttachment =
        {
          id: "/chart.html",
          kind: "context",
          sourceName: "Visualization changes",
          text: null,
          structuredContent: {
            edits: [
              { target: "Chart", changes: [{ label: "Radius", reference: null, value: 40 }] },
            ],
          },
          imageAttachments: [],
          untrusted: true,
        };
      const captured = yield* f.service.prepareMessage({
        threadId: "thread",
        prompt: "Apply the changes",
        promptInput: { text: "Apply the changes", mcpAppModelContextAttachments: [attachment] },
      });
      yield* f.service.acceptFromFollower("thread", [captured]);
      const restored = JSON.parse(JSON.stringify(f.state())) as CodexQueuedMessageState;
      const editing = queuedMessagePromptInput(restored.thread![0]!);
      const replacement = yield* f.service.prepareMessage({
        threadId: "thread",
        prompt: "Keep the background",
        promptInput: editing,
      });
      assert.deepEqual(replacement.context.mcpAppModelContextAttachments, [
        { ...attachment, title: attachment.sourceName },
      ]);
      const compiled = prepareUntrustedAppInput(
        "Keep the background",
        replacement.context,
        "annotations-call",
      );
      assert.strictEqual(
        compiled.input.type === "text" && compiled.input.text,
        "Keep the background",
      );
      const expectedAttachments = [{ ...attachment, title: "Visualization changes" }];
      assert.deepEqual(compiled.modelContextAttachments, expectedAttachments);
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "retains visualization provenance across persistence and queued editing without trusted prose",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const message = {
          source: "visualization",
          sourceId: "widget-a",
          text: "Inspect this selection",
          structuredContent: { selected: [1, 3] },
        } as const;
        const captured = yield* f.service.prepareMessage({
          threadId: "thread",
          prompt: message.text,
          untrustedAppMessage: message,
        });
        yield* f.service.acceptFromFollower("thread", [captured]);
        const restored = JSON.parse(JSON.stringify(f.state())) as CodexQueuedMessageState;
        const editing = queuedMessagePromptInput(restored.thread![0]!);
        const replacement = yield* f.service.prepareMessage({
          threadId: "thread",
          prompt: "Inspect the revised selection",
          promptInput: editing,
        });
        const editedMessage = { ...message, text: "Inspect the revised selection" };
        assert.deepEqual(replacement.context.untrustedAppMessage, editedMessage);
        const compiled = prepareUntrustedAppInput(editedMessage.text, replacement.context, "call");
        assert.strictEqual(
          compiled.input.type === "text" && compiled.input.text,
          "Respond to the user input in the context of our conversation.",
        );
        assert.deepEqual(compiled.responseItems[1], {
          type: "function_call_output",
          call_id: "call",
          output: [
            { type: "input_text", text: JSON.stringify({ kind: "message", ...editedMessage }) },
          ],
        });
      }),
    ).pipe(Effect.provide(callbackLayer)),
);

it.effect("rejects malformed visualization context before creating a queued submission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* f.service
        .prepareMessage({
          threadId: "thread",
          prompt: "inspect",
          untrustedAppMessage: {
            source: "visualization",
            sourceId: "widget-a",
            text: "inspect",
            structuredContent: [],
          } as never,
        })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(f.state(), {});
    }),
  ).pipe(Effect.provide(callbackLayer)),
);
it.effect("persists whole captured queue messages and broadcasts only after the owner write", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({ unrelated: [message("other")] });
      yield* f.service.acceptFromFollower("thread", [message("one")]);
      assert.deepEqual(f.state(), { unrelated: [message("other")], thread: [message("one")] });
      assert.deepEqual(f.broadcasts, [
        { hostId: "local", conversationId: "thread", messages: [message("one")] },
      ]);
      assert.deepEqual(f.events, [{ kind: "queuedMessageStateChanged", value: null }]);
      yield* f.service.acceptFromFollower("thread", []);
      assert.deepEqual(f.state(), { unrelated: [message("other")] });
    }),
  ).pipe(Effect.provide(callbackLayer)),
);
it.effect("a follower refuses an owner-only queue replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({ thread: [message("one"), message("two")] });
      f.setRole({ role: "follower", ownerClientId: "window-owner" });
      const rejected = yield* f.service.acceptFromFollower("thread", []).pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");
    }),
  ).pipe(Effect.provide(callbackLayer)),
);
it.effect("send locks exclude concurrent windows and suppress already sent messages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const request = { conversationId: "thread", messageId: "message", lockId: "window-a" };
      assert.isTrue(service.acquireSendLock(request));
      assert.isFalse(service.acquireSendLock({ ...request, lockId: "window-b" }));
      service.releaseSendLock({ ...request, sent: true });
      assert.isFalse(service.acquireSendLock({ ...request, lockId: "window-b" }));
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

for (const permissionMode of ["auto", "guardian-approvals", "full-access", "custom"] as const) {
  it.effect(
    `retains an explicit queued permission mode through persistence: ${permissionMode}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const input = { threadId: "thread", prompt: "captured choice", permissionMode };
          const captured = yield* f.service.prepareMessage(input);
          yield* f.service.acceptFromFollower("thread", [captured]);
          const restored = JSON.parse(JSON.stringify(f.state())) as CodexQueuedMessageState;
          assert.strictEqual(restored.thread?.[0]?.submissionOptions?.agentMode, permissionMode);
          assert.strictEqual(
            restored.thread?.[0]?.submissionOptions?.shouldSendPermissionOverrides,
            true,
          );
        }),
      ).pipe(Effect.provide(callbackLayer)),
  );
}

it.effect("an implicit queued permission mode does not become an explicit override", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const captured = yield* f.service.prepareMessage({ threadId: "thread", prompt: "continue" });
      assert.strictEqual(captured.submissionOptions?.agentMode, undefined);
      assert.strictEqual(captured.submissionOptions?.shouldSendPermissionOverrides, false);
    }),
  ).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "modern queued permission intent survives persistence without becoming legacy intent",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const captured = yield* f.service.prepareMessage({
          threadId: "thread",
          prompt: "continue",
          permissionSelection: { kind: "profile", profileId: "team-profile" },
          permissionProfileId: "legacy-profile",
          usePermissionSelection: true,
          shouldSendPermissionOverrides: false,
        });
        yield* f.service.acceptFromFollower("thread", [captured]);
        const restored = JSON.parse(JSON.stringify(f.state())) as CodexQueuedMessageState;
        assert.deepEqual(restored.thread?.[0]?.submissionOptions?.permissionSelection, {
          kind: "profile",
          profileId: "team-profile",
        });
        assert.strictEqual(
          restored.thread?.[0]?.submissionOptions?.permissionProfileId,
          "legacy-profile",
        );
        assert.strictEqual(restored.thread?.[0]?.submissionOptions?.usePermissionSelection, true);
        assert.strictEqual(
          restored.thread?.[0]?.submissionOptions?.shouldSendPermissionOverrides,
          false,
        );
        assert.strictEqual(restored.thread?.[0]?.submissionOptions?.agentMode, undefined);
      }),
    ).pipe(Effect.provide(callbackLayer)),
);
