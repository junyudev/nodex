import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainEvent, MessagePortMain, WebContents } from "electron";
import { DICTATION_STREAM_CONNECT_CHANNEL } from "../../../shared/dictation-stream-transport";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { layer as callbacksLayer } from "../../app/ScopedCallbackRuntime";
import { CodexMedia } from "../../codex-application/CodexMedia";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import type { connectDictationStreamingRpc } from "../../platform/electron/DictationStreamingRpc";
import { ElectronSyncIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./DictationStreamingIpc";

class Port extends EventEmitter {
  closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}
class Sender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

const fixture = Effect.fn("fixture")(function* () {
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  let ingress: ((event: IpcMainEvent, ...args: unknown[]) => void) | undefined;
  const retired = vi.fn();
  const connect = vi.fn((..._args: Parameters<typeof connectDictationStreamingRpc>) => ({
    dispose: retired,
  }));
  const ipc = ElectronSyncIpc.of({
    on: (channel, handler) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          expect(channel).toBe(DICTATION_STREAM_CONNECT_CHANNEL);
          ingress = (event, ...args) => {
            Reflect.apply(handler, undefined, [event, ...args]);
          };
        }),
        () =>
          Effect.sync(() => {
            ingress = undefined;
          }),
      ),
  });
  yield* Layer.buildWithScope(
    live({
      authorize: (event) => {
        if (event.sender.id === 9) throw new Error("Untrusted renderer");
      },
      connect,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          callbacksLayer,
          mainConfigLayer(),
          Layer.succeed(ElectronSyncIpc, ipc),
          Layer.succeed(CodexMedia, CodexMedia.of({} as CodexMedia["Service"])),
          Layer.succeed(
            DictationRuntime,
            DictationRuntime.of({
              ownsGlobalRenderer: (id: number) => id === 2,
            } as unknown as DictationRuntime["Service"]),
          ),
          Layer.succeed(
            WindowRuntime,
            WindowRuntime.of({
              has: (id: number) => id === 1,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
    ),
    scope,
  );
  const invoke = (sender: Sender, ports: Port[], ...args: unknown[]): void => {
    if (!ingress) throw new Error("Missing streaming port ingress");
    ingress(
      {
        sender: sender as unknown as WebContents,
        ports: ports as unknown as MessagePortMain[],
      } as IpcMainEvent,
      ...args,
    );
  };
  return { scope, connect, retired, invoke };
});

it.effect(
  "rejects untrusted, unowned, extra-port and payload requests before socket admission",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const cases = [
        { id: 9, ports: [new Port()], args: [] },
        { id: 3, ports: [new Port()], args: [] },
        { id: 1, ports: [new Port(), new Port()], args: [] },
        { id: 1, ports: [new Port()], args: [{ token: "renderer-input" }] },
        { id: 1, ports: [new Port()], args: [undefined, "extra"] },
      ];
      for (const input of cases) {
        context.invoke(new Sender(input.id), input.ports, ...input.args);
        expect(input.ports.every((port) => port.closed)).toBe(true);
      }
      yield* Effect.yieldNow;
      expect(context.connect).not.toHaveBeenCalled();
    }),
);

it.effect(
  "binds overlapping composer and global attempts to their owning surface and lifetime",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const composer = new Sender(1);
      const global = new Sender(2);
      const composerPorts = Array.from({ length: 2 }, () => new Port());
      for (const port of composerPorts) context.invoke(composer, [port], undefined);
      context.invoke(global, [new Port()], undefined);
      yield* Effect.tryPromise(async () => {
        await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(3));
        expect(context.connect.mock.calls.map((args) => args[4])).toEqual([
          "composer",
          "composer",
          "global",
        ]);
        composerPorts[0]!.close();
        await vi.waitFor(() => expect(context.retired).toHaveBeenCalledTimes(1));
        const replacement = new Port();
        context.invoke(composer, [replacement]);
        await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(4));
        expect(replacement.closed).toBe(false);
        expect(composerPorts[1]!.closed).toBe(false);
      });
    }),
);

it.effect("retires ports on renderer reload or destruction and removes lifecycle listeners", () =>
  Effect.gen(function* () {
    const context = yield* fixture();
    const sender = new Sender(1);
    const port = new Port();
    context.invoke(sender, [port]);
    yield* Effect.tryPromise(async () => {
      await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(1));
      sender.emit("did-start-navigation", {}, "nodex://renderer/#route", true, true);
      sender.emit("did-start-navigation", {}, "https://guest.example", false, false);
      expect(port.closed).toBe(false);
      sender.emit("did-start-navigation", {}, "nodex://renderer/", false, true);
      await vi.waitFor(() => expect(context.retired).toHaveBeenCalledTimes(1));
      expect(port.closed).toBe(true);
      expect(sender.listenerCount("destroyed")).toBe(0);
      expect(sender.listenerCount("did-start-navigation")).toBe(0);
      const replacement = new Port();
      context.invoke(sender, [replacement]);
      await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(2));
      sender.emit("destroyed");
      expect(replacement.closed).toBe(true);
      expect(context.retired).toHaveBeenCalledTimes(2);
    });
  }),
);

it.effect("closes every admitted port when the application Scope shuts down", () =>
  Effect.gen(function* () {
    const context = yield* fixture();
    const port = new Port();
    context.invoke(new Sender(1), [port]);
    yield* Effect.tryPromise(async () => {
      await vi.waitFor(() => expect(context.connect).toHaveBeenCalledOnce());
    });
    yield* Scope.close(context.scope, Exit.void);
    expect(port.closed).toBe(true);
    expect(context.retired).toHaveBeenCalledOnce();
  }),
);
