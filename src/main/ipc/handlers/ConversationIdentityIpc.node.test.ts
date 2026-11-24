import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import type { ConversationIdentity } from "../../../shared/conversation-identity";
import { DEVICE_CAPABILITY_CHANNELS, isSpaceIpcChannel } from "../../../shared/space-ipc-policy";
import { testLayer } from "../../app/MainConfig";
import {
  ConversationIdentityError,
  ConversationIdentityQuery,
} from "../../conversation-application/ConversationIdentityQuery";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ConversationIdentityIpc";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;

const runtimeIdentity: ConversationIdentity = {
  execution: "agent-runtime",
  threadId: "thread:task:child",
  sessionId: "parent-session",
  title: "Check routing",
  role: "subagent",
  agent: { kind: "codex", providerInstanceId: "codex", model: null, effort: null },
  archived: false,
  host: null,
};

const event = (
  options: {
    id?: number;
    senderType?: string;
    url?: string;
    mainFrame?: boolean;
    missingFrame?: boolean;
  } = {},
) => {
  const frame = { url: options.url ?? "app://-/index.html" };
  return {
    sender: {
      id: options.id ?? 1,
      getType: () => options.senderType ?? "window",
      mainFrame: options.mainFrame === false ? { ...frame } : frame,
    },
    senderFrame: options.missingFrame ? undefined : frame,
  } as unknown as IpcMainInvokeEvent;
};

const setup = (
  resolve: ConversationIdentityQuery["Service"]["resolve"] = () => Effect.succeed(runtimeIdentity),
  rendererUrl: string | null = null,
) =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const calls: string[] = [];
    yield* Layer.build(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            testLayer({ rendererUrl }),
            Layer.succeed(
              ConversationIdentityQuery,
              ConversationIdentityQuery.of({
                resolve: (threadId) =>
                  Effect.sync(() => calls.push(threadId)).pipe(
                    Effect.flatMap(() => resolve(threadId)),
                  ),
              }),
            ),
            Layer.succeed(
              ElectronIpc,
              makeTestElectronIpc({
                handle: (channel, handler) =>
                  Effect.sync(() => {
                    handlers.set(channel, handler as Handler);
                  }),
                on: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(WindowRuntime, {
              has: (id: number) => id === 1,
            } as WindowRuntime["Service"]),
          ),
        ),
      ),
    );
    return { handlers, calls, invoke: handlers.get("conversation:identity:get")! };
  });

it.effect(
  "registers a Space query that accepts a bare Thread ID and retains Runtime ownership",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      assert.deepEqual([...fixture.handlers.keys()], ["conversation:identity:get"]);
      assert.isTrue(isSpaceIpcChannel("conversation:identity:get"));
      assert.notInclude(DEVICE_CAPABILITY_CHANNELS, "conversation:identity:get");
      assert.strictEqual(yield* fixture.invoke(event(), " \tthread:task:child\n"), runtimeIdentity);
      assert.deepEqual(fixture.calls, ["thread:task:child"]);
    }).pipe(Effect.scoped),
);

it.effect("bounds the trimmed Thread ID and rejects object-shaped or non-string inputs", () =>
  Effect.gen(function* () {
    const fixture = yield* setup(() => Effect.succeed(null));
    const maximumId = "t".repeat(512);
    assert.isNull(yield* fixture.invoke(event(), ` ${maximumId} `));
    for (const input of [
      "t".repeat(513),
      { threadId: "thread:task:child" },
      ["thread:task:child"],
      null,
      undefined,
      123,
    ]) {
      const error = yield* fixture.invoke(event(), input).pipe(Effect.flip);
      assert.instanceOf(error, ConversationIdentityError);
    }
    assert.deepEqual(fixture.calls, [maximumId]);
  }).pipe(Effect.scoped),
);

it.effect(
  "requires an owned app window and its trusted main frame before consulting identity",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      for (const sender of [
        event({ id: 2 }),
        event({ senderType: "webview" }),
        event({ mainFrame: false }),
        event({ missingFrame: true }),
        event({ url: "https://example.com/index.html" }),
        event({ url: "app://untrusted/index.html" }),
      ]) {
        const error = yield* fixture.invoke(sender, runtimeIdentity.threadId).pipe(Effect.flip);
        assert.instanceOf(error, ConversationIdentityError);
      }
      assert.deepEqual(fixture.calls, []);
      assert.strictEqual(yield* fixture.invoke(event(), runtimeIdentity.threadId), runtimeIdentity);
    }).pipe(Effect.scoped),
);

it.effect("admits only the configured development origin for a development renderer", () =>
  Effect.gen(function* () {
    const fixture = yield* setup(undefined, "http://localhost:5173");
    assert.strictEqual(
      yield* fixture.invoke(event({ url: "http://localhost:5173/chat" }), runtimeIdentity.threadId),
      runtimeIdentity,
    );
    const error = yield* fixture
      .invoke(event({ url: "http://localhost:5174/chat" }), runtimeIdentity.threadId)
      .pipe(Effect.flip);
    assert.instanceOf(error, ConversationIdentityError);
    assert.deepEqual(fixture.calls, [runtimeIdentity.threadId]);
  }).pipe(Effect.scoped),
);

it.effect("retains a native local host even when its conversation has a product Session", () =>
  Effect.gen(function* () {
    const nativeIdentity: ConversationIdentity = {
      ...runtimeIdentity,
      execution: "native-codex",
      executionHostId: "local",
      threadId: "019aa111-2222-7333-8444-555555555555",
      sessionId: "native-session",
      role: "chat",
    };
    const fixture = yield* setup(() => Effect.succeed(nativeIdentity));
    assert.strictEqual(yield* fixture.invoke(event(), nativeIdentity.threadId), nativeIdentity);
    assert.deepEqual(fixture.calls, [nativeIdentity.threadId]);
  }).pipe(Effect.scoped),
);

it.effect("preserves missing identities and owner failures without retrying another owner", () =>
  Effect.gen(function* () {
    const failure = new ConversationIdentityError({ cause: new Error("Runtime unavailable") });
    const fixture = yield* setup((threadId) =>
      threadId === "thread:task:failed" ? Effect.fail(failure) : Effect.succeed(null),
    );
    assert.isNull(yield* fixture.invoke(event(), "thread:task:missing"));
    assert.strictEqual(
      yield* fixture.invoke(event(), "thread:task:failed").pipe(Effect.flip),
      failure,
    );
    assert.deepEqual(fixture.calls, ["thread:task:missing", "thread:task:failed"]);
  }).pipe(Effect.scoped),
);
