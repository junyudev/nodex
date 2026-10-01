/* oxlint-disable effecttsgo/async-function -- Exercises RPC over real MessagePorts with scoped Effect resources. */
import { MessageChannel } from "node:worker_threads";
import { RpcSession, type RpcStub } from "capnweb";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  DICTATION_STREAM_MAX_MESSAGE_LENGTH,
  type DictationStreamingService,
  type DictationStreamTransportEvent,
} from "../../../shared/dictation-stream-transport";
import {
  ConversationServicePortTransport,
  type ConversationServicePort,
} from "../../../shared/codex-service-port";
import { ScopedCallbackRuntime, layer as callbacksLayer } from "../../app/ScopedCallbackRuntime";
import { connectDictationStreamingRpc } from "./DictationStreamingRpc";

function adaptPort(port: MessageChannel["port1"]): ConversationServicePort {
  return {
    start: () => port.start(),
    postMessage: (message) => port.postMessage(message),
    close: () => port.close(),
    on: (event, listener) =>
      event === "message"
        ? port.on("message", (data: unknown) => listener({ data }))
        : port.on("close", listener),
  };
}

const fixture = Effect.fn("fixture")(function* (options: { pendingAuth?: boolean } = {}) {
  const processScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const context = yield* Layer.buildWithScope(callbacksLayer, processScope);
  const callbacks = Context.get(context, ScopedCallbackRuntime);
  const socketScope = yield* Scope.fork(processScope, "sequential");
  const counts = { opened: 0, released: 0, authInterrupted: 0 };
  const sent: string[] = [];
  const { port1, port2 } = new MessageChannel();
  const transport = new ConversationServicePortTransport(adaptPort(port2));
  const remote: RpcStub<DictationStreamingService> = new RpcSession<DictationStreamingService>(
    transport,
  ).getRemoteMain();
  const connection = connectDictationStreamingRpc(
    adaptPort(port1),
    {
      openStreaming: (_surface, notify) =>
        Effect.gen(function* () {
          counts.opened++;
          if (options.pendingAuth) {
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  counts.authInterrupted++;
                }),
              ),
            );
          }
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              counts.released++;
            }),
          );
          notify({ type: "open", protocol: "" });
          notify({ type: "message", data: '{"type":"session.started"}' });
          return {
            send: (data: string) => Effect.sync(() => void sent.push(data)),
            close: Effect.void,
          };
        }),
    },
    callbacks,
    socketScope,
    "composer",
  );
  yield* Scope.addFinalizer(socketScope, Effect.sync(connection.dispose));
  yield* Scope.addFinalizer(
    processScope,
    Effect.sync(() => transport.abort(new Error("done"))),
  );
  return { counts, sent, remote, transport, socketScope, processScope, callbacks, port2 };
});

it.effect("forwards events and string frames through one disposable authenticated capability", () =>
  Effect.gen(function* () {
    const context = yield* fixture();
    yield* Effect.tryPromise(async () => {
      const events: DictationStreamTransportEvent[] = [];
      const socket = await context.remote.connect("composer", (event) => {
        events.push(event);
      });
      await vi.waitFor(() =>
        expect(events).toEqual([
          { type: "open", protocol: "" },
          { type: "message", data: '{"type":"session.started"}' },
        ]),
      );
      await socket.send('{"type":"session.start"}');
      expect(context.sent).toEqual(['{"type":"session.start"}']);
      await expect(context.remote.connect("composer", () => {})).rejects.toThrow(
        "Dictation stream operation failed",
      );
      socket[Symbol.dispose]();
      await vi.waitFor(() => expect(context.counts.released).toBe(1));
      expect(context.counts.opened).toBe(1);
    });
  }),
);

it.effect("rejects a different surface and oversized frames before native socket work", () =>
  Effect.gen(function* () {
    const context = yield* fixture();
    yield* Effect.tryPromise(async () => {
      await expect(context.remote.connect("global", () => {})).rejects.toThrow(
        "Dictation stream operation failed",
      );
      expect(context.counts.opened).toBe(0);
      const socket = await context.remote.connect("composer", () => {});
      await expect(
        socket.send("中".repeat(Math.floor(DICTATION_STREAM_MAX_MESSAGE_LENGTH / 3) + 1)),
      ).rejects.toThrow();
      await expect(
        socket.send("x".repeat(DICTATION_STREAM_MAX_MESSAGE_LENGTH + 1)),
      ).rejects.toThrow();
      expect(context.sent).toEqual([]);
      socket[Symbol.dispose]();
      await vi.waitFor(() => expect(context.counts.released).toBe(1));
    });
  }),
);

it.effect("interrupts pending authentication when the renderer closes its RPC port", () =>
  Effect.gen(function* () {
    const context = yield* fixture({ pendingAuth: true });
    yield* Effect.tryPromise(async () => {
      const opening = Promise.resolve(context.remote.connect("composer", () => {})).catch(() => {});
      await vi.waitFor(() => expect(context.counts.opened).toBe(1));
      context.transport.abort(new Error("renderer closed"));
      await opening;
      await vi.waitFor(() => expect(context.counts.authInterrupted).toBe(1));
      expect(context.counts.released).toBe(0);
    });
  }),
);

it.effect("application Scope closure releases a socket and prevents subsequent RPC sends", () =>
  Effect.gen(function* () {
    const context = yield* fixture();
    const socket = yield* Effect.tryPromise(() => context.remote.connect("composer", () => {}));
    yield* Scope.close(context.processScope, Exit.void);
    expect(context.counts.released).toBe(1);
    yield* Effect.tryPromise(() => expect(socket.send("late")).rejects.toThrow());
    expect(context.sent).toEqual([]);
  }),
);
