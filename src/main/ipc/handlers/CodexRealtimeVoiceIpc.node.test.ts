import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { vi } from "vitest";
import type { CodexRealtimeVoiceSnapshot } from "../../../shared/codex-realtime-voice";
import { testLayer as configLayer } from "../../app/MainConfig";
import { CodexRealtimeVoice } from "../../codex-application/CodexRealtimeVoice";
import { CodexRealtimeVoicePolicy } from "../../codex-application/CodexRealtimeVoicePolicy";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { live } from "./CodexRealtimeVoiceIpc";

vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: () => {} },
  BrowserWindow: { fromWebContents: () => ({}) },
  systemPreferences: {},
  ipcMain: {},
  app: {},
  session: {},
  net: {},
  shell: {},
  dialog: {},
  screen: {},
  clipboard: {},
  nativeImage: {},
  Menu: {},
  globalShortcut: {},
  powerMonitor: {},
  webContents: {},
  desktopCapturer: {},
  safeStorage: {},
  nativeTheme: {},
}));
const claimId = "019a1240-1000-7000-8000-000000000001";
const event = (url = "http://localhost:5173", id = 42, kind = "window"): IpcMainInvokeEvent => {
  const frame = { url };
  return {
    sender: { id, getType: () => kind, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
};
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, unknown>;
const withIpc = <A, E>(
  run: (handlers: Map<string, Handler>, calls: unknown[][]) => Effect.Effect<A, E>,
  currentSession: CodexRealtimeVoiceSnapshot | null = null,
) =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const calls: unknown[][] = [];
    const operation = (name: string, ...args: unknown[]) =>
      Effect.sync(() => {
        calls.push([name, ...args]);
      });
    const deps = Layer.mergeAll(
      configLayer({ rendererUrl: "http://localhost:5173" }),
      Layer.succeed(
        ElectronIpc,
        makeTestElectronIpc({
          handle: (channel, handler) =>
            Effect.sync(() => {
              handlers.set(channel, handler as Handler);
            }),
          on: () => Effect.void,
        }),
      ),
      Layer.succeed(RendererClientRuntime, {
        getClientIdForWebContentsId: (id: number) => (id === 42 ? "client" : null),
      } as RendererClientRuntime["Service"]),
      Layer.succeed(CodexRealtimeVoicePolicy, {
        isAvailable: (target: unknown) => operation("availability", target).pipe(Effect.as(false)),
      } as unknown as CodexRealtimeVoicePolicy["Service"]),
      Layer.succeed(CodexRealtimeVoice, {
        readSession: () => {
          calls.push(["read-session"]);
          return currentSession;
        },
        prepare: (sender: number, target: unknown) =>
          operation("prepare", sender, target).pipe(Effect.as({ claimId })),
        start: (sender: number, claim: string, sdp: string) =>
          operation("start", sender, claim, sdp),
        reportMedia: (sender: number, claim: string, evidence: unknown) =>
          operation("media", sender, claim, evidence),
        setMuted: (sender: number, claim: string, value: unknown) =>
          operation("mute", sender, claim, value),
        stop: (sender: number, claim: string) => operation("stop", sender, claim),
        release: (sender: number, claim: string) =>
          operation("release", sender, claim).pipe(Effect.as(true)),
        appendText: (sender: number, claim: string, role: unknown, text: string) =>
          operation("text", sender, claim, role, text),
      } as unknown as CodexRealtimeVoice["Service"]),
    );
    yield* Layer.buildWithScope(live.pipe(Layer.provide(deps)), yield* Scope.Scope);
    return yield* run(handlers, calls);
  }).pipe(Effect.scoped);

it.effect("only a registered physical application renderer can claim native Voice", () =>
  withIpc((handlers, calls) =>
    Effect.gen(function* () {
      const prepare = handlers.get("codex:realtime-voice:prepare")!;
      for (const sender of [
        event("https://foreign.example"),
        event("http://localhost:5173", 43),
        event("http://localhost:5173", 42, "webview"),
      ])
        assert.strictEqual(
          (yield* prepare(sender, { hostId: "ssh:owner", threadId: "thread" }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
      assert.strictEqual(calls.length, 0);
      yield* prepare(event(), { hostId: "ssh:owner", threadId: "thread" });
      assert.deepStrictEqual(calls, [["prepare", 42, { hostId: "ssh:owner", threadId: "thread" }]]);
    }),
  ),
);
it.effect(
  "a different Thread query reports the Profile claim without changing its target admission",
  () => {
    const session: CodexRealtimeVoiceSnapshot = {
      hostId: "local",
      threadId: "owning-thread",
      claimId,
      realtimeSessionId: "019a1240-1000-7000-8000-000000000002",
      phase: "active",
      microphoneMuted: false,
      outputMuted: false,
      revision: 1,
    };
    const target = { hostId: "ssh:other", threadId: "other-thread" };
    return withIpc(
      (handlers, calls) =>
        Effect.gen(function* () {
          const result = yield* handlers.get("codex:realtime-voice:read")!(event(), target);
          assert.deepStrictEqual(result, { available: false, session });
          assert.deepStrictEqual(calls, [["availability", target], ["read-session"]]);
        }),
      session,
    );
  },
);
it.effect(
  "rejects chosen sender identities, unbounded SDP and invalid generated text roles before dispatch",
  () =>
    withIpc((handlers, calls) =>
      Effect.gen(function* () {
        for (const [name, value] of [
          ["prepare", { hostId: "local", threadId: "thread", webContentsId: 1 }],
          ["start", { claimId, sdp: "a".repeat(1_048_577) }],
          ["report-media", { claimId, evidence: "requestAccepted" }],
          ["append-text", { claimId, role: "system", text: "text" }],
          ["stop", { claimId: "not-a-claim" }],
        ] as const)
          assert.strictEqual(
            (yield* handlers.get(`codex:realtime-voice:${name}`)!(event(), value).pipe(
              Effect.result,
            ))._tag,
            "Failure",
          );
        assert.strictEqual(calls.length, 0);
        yield* handlers.get("codex:realtime-voice:start")!(event(), { claimId, sdp: "offer" });
        yield* handlers.get("codex:realtime-voice:append-text")!(event(), {
          claimId,
          role: "user",
          text: " exact ",
        });
        assert.deepStrictEqual(calls, [
          ["start", 42, claimId, "offer"],
          ["text", 42, claimId, "user", " exact "],
        ]);
      }),
    ),
);
