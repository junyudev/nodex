/* oxlint-disable effecttsgo/strict-effect-provide -- Test owns the complete temporary Profile IPC graph. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it, assert } from "@effect/vitest";
import { vi } from "vitest";
import { live as stateLive } from "../../codex-application/CodexVisualizationState";
import { ProfilePersistedAtoms } from "../../local-store/ProfilePersistedAtoms";
import { makePersistedAtomStore } from "../../local-store/persisted-atoms";
import { testLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./CodexVisualizationStateIpc";
import { live as localStateIpcLive } from "./ApplicationLocalStateIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, Error>;
function event(kind = "window", url = "http://localhost:5173"): IpcMainInvokeEvent {
  const frame = { url };
  return {
    sender: { id: 42, getType: () => kind, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}

it.effect(
  "admits fixed state only from the owning app window and broadcasts one committed revision",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-widget-state-ipc-"))),
      (home) => {
        const handlers = new Map<string, Handler>();
        const published: unknown[][] = [];
        let registered = true;
        const store = makePersistedAtomStore(home);
        const dependencies = Layer.mergeAll(
          Layer.succeed(ProfilePersistedAtoms, store),
          stateLive.pipe(Layer.provide(Layer.succeed(ProfilePersistedAtoms, store))),
          testLayer({ nodexHome: home, rendererUrl: "http://localhost:5173" }),
          Layer.succeed(
            ElectronIpc,
            makeTestElectronIpc({
              handle: (channel, handler) =>
                Effect.sync(() => handlers.set(channel, handler as Handler)),
              on: () => Effect.void,
            }),
          ),
          Layer.succeed(WindowRuntime, {
            has: () => registered,
            all: () => [
              {
                isDestroyed: () => false,
                webContents: {
                  isDestroyed: () => false,
                  send: (...args: unknown[]) => published.push(args),
                },
              },
            ],
          } as unknown as WindowRuntime["Service"]),
        );
        return Effect.gen(function* () {
          const identity = { hostId: "local", threadId: "display", path: "/plot.html" };
          const write = handlers.get("codex:visualization:state:write")!;
          const read = handlers.get("codex:visualization:state:read")!;
          const input = { identity, state: { selected: 7 }, mutationId: "widget-update" };
          for (const caller of [event("webview"), event("window", "https://untrusted.example")])
            assert.strictEqual((yield* Effect.result(write(caller, input)))._tag, "Failure");
          assert.strictEqual(store.readSnapshot().revision, 0);
          assert.deepEqual(yield* write(event(), input), {
            ok: true,
            revision: 1,
            value: { modelContent: null, privateContent: null, selected: 7 },
          });
          assert.deepEqual(yield* read(event(), identity), {
            modelContent: null,
            privateContent: null,
            selected: 7,
          });
          assert.strictEqual(published.length, 1);
          assert.strictEqual(published[0]?.[0], "persisted-atom:updated");
          assert.deepEqual(yield* write(event(), { ...input, state: { imageIds: ["image"] } }), {
            ok: false,
            code: "images_unsupported",
            retryable: false,
          });
          assert.strictEqual(published.length, 1);
          const interactionWrite = handlers.get("codex:visualization:interaction:write")!;
          assert.strictEqual(
            (yield* Effect.result(
              interactionWrite(event("webview"), {
                identity,
                state: { modelContent: { selected: 2 } },
                mutationId: "guest-forgery",
              }),
            ))._tag,
            "Failure",
          );
          const interaction = yield* interactionWrite(event(), {
            identity,
            state: { modelContent: { selected: 2 } },
            mutationId: "host-adjustment",
          });
          assert.deepEqual(interaction, {
            ok: true,
            revision: 2,
            value: { modelContent: { selected: 2 } },
          });
          assert.strictEqual(published.length, 2);
          registered = false;
          assert.strictEqual((yield* Effect.result(read(event(), identity)))._tag, "Failure");
        }).pipe(
          Effect.provide(Layer.merge(live, localStateIpcLive).pipe(Layer.provide(dependencies))),
          Effect.scoped,
        );
      },
      (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
    ),
);
