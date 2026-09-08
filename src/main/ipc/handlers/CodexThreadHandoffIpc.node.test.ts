import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";
import type { CodexThreadHandoffSnapshot } from "../../../shared/codex-thread-handoff";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexThreadHandoffRuntime } from "../../codex-application/CodexThreadHandoffRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, type CodexThreadHandoffIpcError } from "./CodexThreadHandoffIpc";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  protocol: {},
  nativeTheme: {},
  screen: {},
  session: {},
}));

const rendererEvent = (id: number, url = "app://-/index.html"): IpcMainInvokeEvent => {
  const frame = { url };
  return {
    sender: { getType: () => "window", id, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
};

it.effect(
  "authorizes snapshot reads and scopes progress delivery to the renderer ingress lifetime",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<
        string,
        (event: IpcMainInvokeEvent) => Effect.Effect<unknown, CodexThreadHandoffIpcError>
      >();
      const delivered: unknown[][] = [];
      const state = yield* SubscriptionRef.make<CodexThreadHandoffSnapshot>({
        revision: 0,
        operations: [],
      });
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as never)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.die("unused"),
      });
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(CodexThreadHandoffRuntime, {
                snapshot: SubscriptionRef.get(state),
                changes: SubscriptionRef.changes(state),
              } as CodexThreadHandoffRuntime["Service"]),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id === 7,
                all: () => [
                  {
                    isDestroyed: () => false,
                    webContents: {
                      isDestroyed: () => false,
                      send: (...args: unknown[]) => delivered.push(args),
                    },
                  },
                ],
              } as unknown as WindowRuntime["Service"]),
              mainConfigLayer(),
            ),
          ),
        ),
        scope,
      );
      const read = handlers.get("codex:thread-handoffs:list")!;
      assert.deepEqual(yield* read(rendererEvent(7)), { revision: 0, operations: [] });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(read(rendererEvent(8)))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(read(rendererEvent(7, "https://untrusted.example")))),
      );
      yield* SubscriptionRef.set(state, { revision: 1, operations: [] });
      yield* Effect.yieldNow;
      assert.deepEqual(delivered.at(-1), [
        "codex:thread-handoffs:changed",
        { revision: 1, operations: [] },
      ]);
      yield* Scope.close(scope, Exit.void);
      const deliveredCount = delivered.length;
      yield* SubscriptionRef.set(state, { revision: 2, operations: [] });
      yield* Effect.yieldNow;
      assert.strictEqual(delivered.length, deliveredCount);
      assert.strictEqual(handlers.size, 0);
    }),
);
