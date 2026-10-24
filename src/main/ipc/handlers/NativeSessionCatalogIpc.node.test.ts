import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import type {
  CodexThreadImportInput,
  NativeSessionAttachInput,
  NativeSessionCatalogInput,
} from "../../../shared/native-session-catalog";
import { NativeSessionCatalog } from "../../agent-backend/NativeSessionCatalog";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
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
vi.mock("../../agent-runtime/AgentRuntimeApplication", async () => {
  const Context = await import("effect/Context");
  return {
    AgentRuntimeApplication: class extends Context.Service<unknown, unknown>()(
      "test/AgentRuntimeApplication",
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
  const prepared: CodexThreadImportInput[] = [];
  const imported: Parameters<AgentRuntimeApplication["Service"]["importCodex"]>[0][] = [];
  const state = { completed: false };
  const source = {
    nativeSessionId: "019abcde-1234-7000-8000-123456789abc",
    nativeHome: "/native-home",
    title: "Source chat",
    cwd: "/missing",
    cwdAvailable: false,
    updatedAt: 1,
    model: "model",
  };
  const catalog = NativeSessionCatalog.of({
    previewCodexImport: () => Effect.succeed(source),
    prepareCodexImport: (input) =>
      Effect.sync(() => {
        prepared.push(input);
        return source;
      }),
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
          Layer.succeed(AgentRuntimeApplication, {
            completedCodexImport: (input: CodexThreadImportInput) =>
              Effect.succeed(
                state.completed
                  ? {
                      sessionId: input.requestId,
                      threadId: "runtime-thread",
                      projectId: input.projectId,
                    }
                  : null,
              ),
            importCodex: (
              input: Parameters<AgentRuntimeApplication["Service"]["importCodex"]>[0],
            ) =>
              Effect.sync(() => {
                imported.push(input);
                return {
                  sessionId: input.requestId,
                  threadId: "runtime-thread",
                  projectId: input.projectId,
                };
              }),
          } as unknown as AgentRuntimeApplication["Service"]),
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
  const importCodex = handlers.get("native-sessions:import-codex");
  const preview = handlers.get("native-sessions:preview-codex-import");
  if (!list || !attach || !importCodex || !preview)
    throw new Error("Native conversation IPC handlers are unavailable.");
  return { list, attach, listed, attached, importCodex, preview, prepared, imported, state };
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
  "imports only validated source metadata and recovers completed copies without rereading the source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const input: CodexThreadImportInput = {
          requestId: "019d0000-0000-7000-8000-000000000002",
          acceptedAt: 1,
          nativeSessionId: "019abcde-1234-7000-8000-123456789abc",
          expectedHome: "/native-home",
          projectId: null,
          cwd: "/replacement",
        };
        for (const malformed of [
          { ...input, requestId: "wrong" },
          { ...input, nativeSessionId: "wrong" },
          { ...input, cwd: " " },
          { ...input, expectedHome: "" },
          { ...input, acceptedAt: -1 },
          { ...input, title: "Untrusted title" },
        ])
          assert.equal(
            (yield* fixture.importCodex(trustedEvent(), malformed).pipe(Effect.result))._tag,
            "Failure",
          );
        assert.equal(
          (yield* fixture.importCodex(trustedEvent({ subframe: true }), input).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(fixture.prepared.length, 0);
        yield* fixture.importCodex(trustedEvent(), input);
        assert.deepEqual(fixture.imported, [{ ...input, title: "Source chat", model: "model" }]);
        fixture.state.completed = true;
        assert.deepEqual(yield* fixture.importCodex(trustedEvent(), input), {
          sessionId: input.requestId,
          threadId: "runtime-thread",
          projectId: null,
        });
        assert.equal(fixture.prepared.length, 1);
        assert.equal(fixture.imported.length, 1);
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
