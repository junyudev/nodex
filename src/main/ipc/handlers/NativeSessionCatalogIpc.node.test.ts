import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import type {
  NativeSessionAttachInput,
  NativeSessionCatalogInput,
} from "../../../shared/native-session-catalog";
import { NativeSessionCatalog } from "../../agent-backend/NativeSessionCatalog";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, type NativeSessionCatalogIpcError } from "./NativeSessionCatalogIpc";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
}));
vi.mock("../../agent-backend/NativeSessionCatalog", async () => {
  const Context = await import("effect/Context");
  return {
    NativeSessionCatalog: class extends Context.Service<unknown, unknown>()(
      "test/NativeSessionCatalog",
    ) {},
  };
});

type Handler = (
  event: IpcMainInvokeEvent,
  value: unknown,
) => Effect.Effect<unknown, NativeSessionCatalogIpcError>;
const trustedEvent = (options: { url?: string; subframe?: boolean; windowId?: number } = {}) => {
  const frame = { url: options.url ?? "app://-/index.html" };
  return {
    sender: { id: options.windowId ?? 77, getType: () => "window", mainFrame: frame },
    senderFrame: options.subframe ? { ...frame } : frame,
  } as unknown as IpcMainInvokeEvent;
};

const makeFixture = Effect.fn("NativeSessionCatalogIpc.testFixture")(function* () {
  const handlers = new Map<string, Handler>();
  const ipc = makeTestElectronIpc({
    handle: (channel: string, handler: Handler) =>
      Effect.acquireRelease(
        Effect.sync(() => handlers.set(channel, handler)),
        () => Effect.sync(() => handlers.delete(channel)),
      ).pipe(Effect.asVoid),
    on: () => Effect.void,
  });
  const listed: NativeSessionCatalogInput[] = [];
  const attached: NativeSessionAttachInput[] = [];
  const catalog = NativeSessionCatalog.of({
    list: (input) =>
      Effect.sync(() => {
        listed.push(input);
        return { nativeHome: "/native-home", entries: [], nextCursor: null };
      }),
    attach: (input) =>
      Effect.sync(() => {
        attached.push(input);
        return { sessionId: "nodex-session", threadId: "nodex-thread", alreadyAttached: false };
      }),
  });
  yield* Layer.buildWithScope(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          mainConfigLayer(),
          Layer.succeed(NativeSessionCatalog, catalog),
          Layer.succeed(ElectronIpc, ipc),
          Layer.succeed(
            WindowRuntime,
            WindowRuntime.of({
              has: (id: number) => id === 77,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
    ),
    yield* Scope.Scope,
  );
  const list = handlers.get("native-sessions:list");
  const attach = handlers.get("native-sessions:attach");
  if (!list || !attach) throw new Error("Native conversation IPC handlers are unavailable.");
  return { list, attach, listed, attached };
});

it.effect("validates exact native catalog inputs before admitting a connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const event = trustedEvent();
      const input: NativeSessionAttachInput = {
        backendKind: "claude",
        instanceConfigId: "personal",
        nativeSessionId: "native-uuid",
        expectedHome: "/native-home",
        projectId: "selected-project",
      };
      const cursor = "x".repeat(6000);
      yield* fixture.list(event, {
        backendKind: "claude",
        instanceConfigId: "personal",
        cursor,
      });
      yield* fixture.attach(event, input);
      assert.deepEqual(fixture.listed, [
        { backendKind: "claude", instanceConfigId: "personal", cursor },
      ]);
      assert.deepEqual(fixture.attached, [input]);
      for (const malformed of [
        { ...input, backendKind: "acp" },
        { ...input, projectId: undefined },
        { ...input, cwd: "/renderer-chosen-workspace" },
        { ...input, expectedHome: "" },
      ]) {
        assert.equal((yield* fixture.attach(event, malformed).pipe(Effect.result))._tag, "Failure");
      }
      assert.equal(
        (yield* fixture
          .list(event, { backendKind: "codex", cursor: "x".repeat(8193) })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.attached.length, 1);
      assert.equal(fixture.listed.length, 1);
    }),
  ),
);

it.effect(
  "rejects foreign documents, subframes and closed windows before native catalog reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const events = [
          trustedEvent({ url: "https://example.com/" }),
          trustedEvent({ subframe: true }),
          trustedEvent({ windowId: 78 }),
        ];
        for (const untrusted of events)
          assert.equal(
            (yield* fixture.list(untrusted, { backendKind: "codex" }).pipe(Effect.result))._tag,
            "Failure",
          );
        assert.equal(fixture.listed.length, 0);
      }),
    ),
);
