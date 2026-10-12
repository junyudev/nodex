/* oxlint-disable effecttsgo/strict-effect-provide -- Each test is the managed entry point for its complete isolated IPC dependency graph. */
import { it, assert } from "@effect/vitest";
import { vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexVisualizations } from "../../codex-application/CodexVisualizations";
import { McpAppSandboxRuntime } from "../../host-runtime/McpAppSandboxRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { live } from "./CodexVisualizationIpc";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("electron", () => ({
  shell: { openExternal },
  BrowserWindow: { fromWebContents: () => ({}) },
}));
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, Error>;
const sandboxId = "source-1234567890abcdef";
function event(url = "http://localhost:5173", kind = "window"): IpcMainInvokeEvent {
  const frame = { url };
  return {
    sender: { id: 42, getType: () => kind, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}
const setup = (
  run: (input: {
    handlers: Map<string, Handler>;
    reads: unknown[];
    gestures: unknown[];
    grant: () => void;
  }) => Effect.Effect<void, Error>,
) => {
  const handlers = new Map<string, Handler>();
  const reads: unknown[] = [];
  const gestures: unknown[] = [];
  let granted = false;
  const dependencies = Layer.mergeAll(
    mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
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
    Layer.succeed(CodexVisualizations, {
      read: (input) =>
        Effect.sync(() => {
          reads.push(input);
          return { contents: "<html></html>", path: "/scoped/plot.html" };
        }),
    }),
    Layer.succeed(McpAppSandboxRuntime, {
      consumeUserGesture: (owner: WebContents, sandbox: string, init?: string) => {
        gestures.push([owner, sandbox, init]);
        const allowed = granted;
        granted = false;
        return allowed;
      },
    } as unknown as McpAppSandboxRuntime["Service"]),
  );
  return run({
    handlers,
    reads,
    gestures,
    grant: () => {
      granted = true;
    },
  }).pipe(Effect.provide(live.pipe(Layer.provide(dependencies))), Effect.scoped);
};

it.effect("routes visualization reads only from the trusted app frame", () =>
  setup(({ handlers, reads }) =>
    Effect.gen(function* () {
      const input = { hostId: "local", sourceThreadId: "native-thread", file: "plot.html" };
      const handler = handlers.get("codex:visualization:read")!;
      assert.deepEqual(yield* handler(event(), input), {
        contents: "<html></html>",
        path: "/scoped/plot.html",
      });
      assert.isTrue(
        (yield* Effect.result(handler(event("https://untrusted.example"), input)))._tag ===
          "Failure",
      );
      assert.isTrue(
        (yield* Effect.result(handler(event("http://localhost:5173", "webview"), input)))._tag ===
          "Failure",
      );
      assert.deepEqual(reads, [input]);
    }),
  ),
);

it.effect("requires and consumes the owning guest's gesture once before opening HTTPS", () =>
  setup(({ handlers, gestures, grant }) =>
    Effect.gen(function* () {
      openExternal.mockClear();
      const owner = event();
      const handler = handlers.get("codex:visualization:open-external")!;
      const input = { sandboxId, initId: "document-one", href: "https://example.com/plot" };
      assert.strictEqual(yield* handler(owner, input), false);
      assert.strictEqual(openExternal.mock.calls.length, 0);
      grant();
      assert.strictEqual(yield* handler(owner, input), true);
      assert.strictEqual(yield* handler(owner, input), false);
      assert.deepEqual(gestures, [
        [owner.sender, sandboxId, "document-one"],
        [owner.sender, sandboxId, "document-one"],
        [owner.sender, sandboxId, "document-one"],
      ]);
      assert.deepEqual(openExternal.mock.calls, [["https://example.com/plot"]]);
    }),
  ),
);

it.effect(
  "consumes a follow-up gesture once for the trusted owning renderer and guest instance",
  () =>
    setup(({ handlers, gestures, grant }) =>
      Effect.gen(function* () {
        const owner = event();
        const handler = handlers.get("codex:visualization:consume-gesture")!;
        const input = { sandboxId, initId: "guest-v2" };
        grant();
        assert.isTrue(yield* handler(owner, input));
        assert.isFalse(yield* handler(owner, input));
        assert.deepEqual(gestures, [
          [owner.sender, sandboxId, "guest-v2"],
          [owner.sender, sandboxId, "guest-v2"],
        ]);
        assert.strictEqual(
          (yield* Effect.result(handler(event("https://untrusted.example"), input)))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* Effect.result(handler(owner, { sandboxId: "forged" })))._tag,
          "Failure",
        );
        assert.strictEqual(gestures.length, 2);
      }),
    ),
);

it.effect("rejects invalid URLs and sandbox identities before consuming a gesture", () =>
  setup(({ handlers, gestures, grant }) =>
    Effect.gen(function* () {
      openExternal.mockClear();
      grant();
      const handler = handlers.get("codex:visualization:open-external")!;
      for (const input of [
        { sandboxId, href: "https://user:secret@example.com" },
        { sandboxId, href: "http://example.com" },
        { sandboxId: "arbitrary", href: "https://example.com" },
      ])
        assert.isTrue((yield* Effect.result(handler(event(), input)))._tag === "Failure");
      assert.deepEqual(gestures, []);
      assert.strictEqual(openExternal.mock.calls.length, 0);
    }),
  ),
);
