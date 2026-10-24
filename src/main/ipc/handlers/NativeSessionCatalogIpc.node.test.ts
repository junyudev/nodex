import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import type {
  NativeConversationImportInput,
  NativeSessionCatalogInput,
} from "../../../shared/native-session-catalog";
import {
  NativeSessionCatalog,
  type NativeSessionCatalogError,
} from "../../agent-backend/NativeSessionCatalog";
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
    AgentRuntimeApplicationError: class extends Error {
      readonly admissionRejected?: true;
      constructor(input: { message: string; admissionRejected?: true }) {
        super(input.message);
        this.admissionRejected = input.admissionRejected;
      }
    },
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
  const prepared: NativeConversationImportInput[] = [];
  const imported: Array<NativeConversationImportInput & { title: string; model: string | null }> =
    [];
  const state = { completed: false, preparationFailure: null as "validation" | "transport" | null };
  const source = {
    backendKind: "codex" as const,
    nativeSessionId: "019abcde-1234-7000-8000-123456789abc",
    nativeHome: "/native-home",
    title: "Source chat",
    cwd: "/missing",
    cwdAvailable: false,
    updatedAt: 1,
    model: "model",
  };
  const catalog = NativeSessionCatalog.of({
    previewImport: () => Effect.succeed({ matches: [source] }),
    prepareImport: (input) =>
      Effect.gen(function* () {
        prepared.push(input);
        if (state.preparationFailure)
          return yield* Effect.fail(
            Object.assign(new Error("Source unavailable"), {
              ...(state.preparationFailure === "validation" ? { admissionRejected: true } : {}),
            }) as NativeSessionCatalogError,
          );
        return source;
      }),
    list: (input) =>
      Effect.sync(() => {
        listed.push(input);
        return { nativeHome: "/native-home", entries: [], nextCursor: null };
      }),
  });
  yield* Layer.buildWithScope(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          mainConfigLayer(),
          Layer.succeed(NativeSessionCatalog, catalog),
          Layer.succeed(AgentRuntimeApplication, {
            findNativeImports: () => Effect.succeed([]),
            submitNativeImport: (
              input: NativeConversationImportInput,
              prepare: Effect.Effect<{ title: string; model: string | null }, unknown>,
            ) =>
              Effect.gen(function* () {
                if (!state.completed) {
                  const metadata = yield* prepare;
                  imported.push({ ...input, title: metadata.title, model: metadata.model });
                }
                return {
                  kind: "imported" as const,
                  sessionId: input.requestId,
                  threadId: "runtime-thread",
                  projectId: input.projectId,
                };
              }).pipe(
                Effect.catch((cause) =>
                  cause instanceof Error &&
                  "admissionRejected" in cause &&
                  cause.admissionRejected === true
                    ? Effect.succeed({ kind: "not_admitted" as const, message: cause.message })
                    : Effect.fail(cause),
                ),
              ),
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
  const importNative = handlers.get("native-sessions:import");
  const preview = handlers.get("native-sessions:preview-import");
  if (!list || !importNative || !preview)
    throw new Error("Native conversation IPC handlers are unavailable.");
  return { list, listed, importNative, preview, prepared, imported, state };
});

it.effect(
  "imports only validated source metadata and recovers completed copies without rereading the source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const input: NativeConversationImportInput = {
          backendKind: "codex",
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
          { ...input, backendKind: "claude" },
          { ...input, instanceConfigId: "wrong" },
        ])
          assert.equal(
            (yield* fixture.importNative(trustedEvent(), malformed).pipe(Effect.result))._tag,
            "Failure",
          );
        assert.equal(
          (yield* fixture.importNative(trustedEvent({ subframe: true }), input).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(fixture.prepared.length, 0);
        yield* fixture.importNative(trustedEvent(), input);
        assert.deepEqual(fixture.imported, [{ ...input, title: "Source chat", model: "model" }]);
        fixture.state.completed = true;
        assert.deepEqual(yield* fixture.importNative(trustedEvent(), input), {
          kind: "imported",
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

it.effect("passes only typed source validation refusals through the admission outcome", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const input: NativeConversationImportInput = {
        backendKind: "codex",
        requestId: "019d0000-0000-7000-8000-000000000002",
        acceptedAt: 1,
        nativeSessionId: "019abcde-1234-7000-8000-123456789abc",
        expectedHome: "/native-home",
        projectId: null,
        cwd: "/replacement",
      };
      fixture.state.preparationFailure = "validation";
      assert.deepEqual(yield* fixture.importNative(trustedEvent(), input), {
        kind: "not_admitted",
        message: "Source unavailable",
      });
      fixture.state.preparationFailure = "transport";
      assert.equal(
        (yield* fixture.importNative(trustedEvent(), input).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.imported.length, 0);
    }),
  ),
);
