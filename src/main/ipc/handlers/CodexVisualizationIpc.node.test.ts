/* oxlint-disable effecttsgo/strict-effect-provide -- Each test is the managed entry point for its complete isolated IPC dependency graph. */
import { it, assert } from "@effect/vitest";
import { vi } from "vitest";
import type { IpcMainInvokeEvent, NativeImage, WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexVisualizations } from "../../codex-application/CodexVisualizations";
import { McpAppSandboxRuntime } from "../../host-runtime/McpAppSandboxRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronClipboard } from "../../platform/electron/ElectronClipboard";
import { McpAppSandboxCaptureError } from "../../mcp-app/mcp-app-sandbox-host";
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
    captures: unknown[];
    copies: NativeImage[];
    releases: unknown[];
    presentations: unknown[];
  }) => Effect.Effect<void, Error>,
) => {
  const handlers = new Map<string, Handler>();
  const reads: unknown[] = [];
  const gestures: unknown[] = [];
  const captures: unknown[] = [];
  const copies: NativeImage[] = [];
  const releases: unknown[] = [];
  const presentations: unknown[] = [];
  const image = {
    getSize: () => ({ width: 2000, height: 1000 }),
    crop: (rect: unknown) => ({ toPNG: () => Buffer.from(JSON.stringify(rect)) }),
  } as unknown as NativeImage;
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
      setGuestPresentation: (
        owner: WebContents,
        sandbox: string,
        init: string,
        active: boolean,
        revision: number,
      ) => {
        presentations.push([owner.id, sandbox, init, active, revision]);
        return true;
      },
      releaseGuest: (owner: WebContents, sandbox: string, init: string) => {
        releases.push([owner.id, sandbox, init]);
        return true;
      },
      captureImage: (owner: WebContents, sandbox: string, init: string) =>
        Effect.suspend(() => {
          captures.push([owner.id, sandbox, init]);
          if (init !== "init-fixture")
            return Effect.fail(new McpAppSandboxCaptureError({ reason: "unavailable" }));
          return Effect.succeed(image);
        }),
      consumeUserGesture: (owner: WebContents, sandbox: string, init?: string) => {
        gestures.push([owner, sandbox, init]);
        const allowed = granted;
        granted = false;
        return allowed;
      },
    } as unknown as McpAppSandboxRuntime["Service"]),
    Layer.succeed(ElectronClipboard, {
      writeImage: (value: NativeImage) =>
        Effect.sync(() => {
          copies.push(value);
        }),
    } as unknown as ElectronClipboard["Service"]),
  );
  return run({
    handlers,
    reads,
    gestures,
    captures,
    copies,
    releases,
    presentations,
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

it.effect("captures the owned guest with native pixel crop and copies only a valid image", () =>
  setup(({ handlers, captures, copies }) =>
    Effect.gen(function* () {
      const input = {
        sandboxId,
        initId: "init-fixture",
        captureRect: { x: 32, y: 32, width: 600, height: 300 },
        viewportSize: { width: 1000, height: 500 },
      };
      const capture = handlers.get("codex:visualization:capture-image")!;
      const bytes = yield* capture(event(), input);
      assert.deepEqual(JSON.parse(Buffer.from(bytes as Uint8Array).toString()), {
        x: 0,
        y: 0,
        width: 1328,
        height: 728,
      });
      const copy = handlers.get("codex:visualization:copy-image")!;
      yield* copy(event(), input);
      assert.strictEqual(copies.length, 1);
      assert.deepEqual(captures, [
        [42, sandboxId, "init-fixture"],
        [42, sandboxId, "init-fixture"],
      ]);
      for (const invalid of [
        { ...input, initId: "" },
        { ...input, captureRect: { ...input.captureRect, width: Infinity } },
        { ...input, captureRect: { ...input.captureRect, x: 900 } },
      ])
        assert.strictEqual((yield* Effect.result(copy(event(), invalid)))._tag, "Failure");
      assert.strictEqual(
        (yield* Effect.result(copy(event("https://untrusted.example"), input)))._tag,
        "Failure",
      );
      assert.strictEqual(captures.length, 2);
      assert.strictEqual(
        (yield* Effect.result(copy(event(), { ...input, initId: "retired-attempt" })))._tag,
        "Failure",
      );
      assert.strictEqual(copies.length, 1);
    }),
  ),
);

it.effect("releases a registered presentation only from its trusted owner and exact init", () =>
  setup(({ handlers, releases }) =>
    Effect.gen(function* () {
      const release = handlers.get("codex:visualization:release")!;
      assert.isTrue(yield* release(event(), { sandboxId, initId: "init-fixture" }));
      assert.deepEqual(releases, [[42, sandboxId, "init-fixture"]]);
      for (const input of [{ sandboxId }, { sandboxId: "forged", initId: "init-fixture" }])
        assert.strictEqual((yield* Effect.result(release(event(), input)))._tag, "Failure");
      assert.strictEqual(
        (yield* Effect.result(
          release(event("https://untrusted.example"), { sandboxId, initId: "init-fixture" }),
        ))._tag,
        "Failure",
      );
      assert.strictEqual(releases.length, 1);
    }),
  ),
);

it.effect("validates a resumable guest presentation before dispatching to its owner", () =>
  setup(({ handlers, presentations }) =>
    Effect.gen(function* () {
      const update = handlers.get("codex:visualization:set-presentation")!;
      const input = { sandboxId, initId: "init-fixture", active: false, revision: 1 };
      assert.isTrue(yield* update(event(), input));
      assert.deepEqual(presentations, [[42, sandboxId, "init-fixture", false, 1]]);
      for (const invalid of [
        { ...input, sandboxId: "forged" },
        { ...input, initId: "" },
        { ...input, initId: "other/document" },
        { ...input, active: "false" },
        { ...input, revision: 0 },
        { ...input, revision: 1.5 },
        { ...input, revision: Number.MAX_SAFE_INTEGER + 1 },
        { ...input, revision: Infinity },
      ])
        assert.strictEqual((yield* Effect.result(update(event(), invalid)))._tag, "Failure");
      assert.strictEqual(
        (yield* Effect.result(update(event("https://untrusted.example"), input)))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.result(update(event("http://localhost:5173", "webview"), input)))._tag,
        "Failure",
      );
      assert.strictEqual(presentations.length, 1);
    }),
  ),
);
