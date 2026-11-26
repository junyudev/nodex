import { NativeAutomationImport } from "../../agent-backend/NativeAutomationImport";
import { tmpdir } from "node:os";
import { ProjectWorkspace } from "../../project-application/ProjectWorkspace";
// @effect-diagnostics strictEffectProvide:off
import { describe, expect, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import type { AgentBackendHistoryReadInput } from "../../../shared/agent-backend-api";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { AgentBackendIpcError, live } from "./AgentBackendIpc";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeAgentDiscoveryRequests } from "./AgentDiscoveryRequests";
import type {
  NativeConversationImportInput,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import {
  NativeSessionCatalog,
  type NativeSessionCatalogError,
} from "../../agent-backend/NativeSessionCatalog";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import {
  live as liveNativeSessionCatalogIpc,
  type NativeSessionCatalogIpcError,
} from "./NativeSessionCatalogIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

vi.mock("../../agent-backend/AgentBackendApplication", async () => {
  const Context = await import("effect/Context");
  return {
    AgentBackendApplication: class extends Context.Service<unknown, unknown>()(
      "test/AgentBackendApplication",
    ) {},
  };
});

vi.mock("../../agent-backend/NativeSessionCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent-backend/NativeSessionCatalog")>();
  const Context = await import("effect/Context");
  return {
    ...actual,
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

describe("AgentBackendIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    value: unknown,
  ) => Effect.Effect<unknown, AgentBackendIpcError>;
  it.effect(
    "bounded native history IPC verifies the owning renderer and rejects malformed pages",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const reads: AgentBackendHistoryReadInput[] = [];
        const ipc = makeTestElectronIpc({
          handle: (channel, handler) =>
            Effect.acquireRelease(
              Effect.sync(() => handlers.set(channel, handler as Handler)),
              () => Effect.sync(() => handlers.delete(channel)),
            ).pipe(Effect.asVoid),
          on: () => Effect.void,
        });
        const application = {
          readAgentHistory: (input: AgentBackendHistoryReadInput) =>
            Effect.sync(() => {
              reads.push(input);
              return { sessionId: "native", status: "closed", turns: [] };
            }),
        } as unknown as AgentBackendApplication["Service"];
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentBackendApplication, application),
                Layer.succeed(ElectronIpc, ipc),
                mainConfigLayer(),
                Layer.succeed(WindowRuntime, {
                  has: (id: number) => id === 77,
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
          scope,
        );
        const frame = { url: "app://-/index.html" };
        const sender = Object.assign(new EventEmitter(), {
          id: 77,
          getType: () => "window",
          isDestroyed: () => false,
          mainFrame: frame,
        });
        const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
        const read = handlers.get("agent-backend:session:history")!;
        const input = { threadId: "attached", before: "older", limit: 50 };
        assert.deepEqual(yield* read(event, input), {
          sessionId: "native",
          status: "closed",
          turns: [],
        });
        assert.deepEqual(reads, [input]);
        for (const invalid of [
          { ...input, limit: 0 },
          { ...input, limit: 51 },
          { ...input, limit: 2.5 },
          { ...input, before: "" },
          { ...input, before: "x".repeat(8193) },
          { ...input, cwd: "/forged" },
          { ...input, sessionId: "foreign" },
        ])
          assert.isTrue(Exit.isFailure(yield* Effect.exit(read(event, invalid))));
        const childFrame = { url: frame.url };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              read({ ...event, senderFrame: childFrame } as IpcMainInvokeEvent, input),
            ),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              read(
                {
                  ...event,
                  sender: Object.assign(new EventEmitter(), {
                    id: 99,
                    mainFrame: frame,
                    getType: () => "window",
                    isDestroyed: () => false,
                  }),
                } as IpcMainInvokeEvent,
                input,
              ),
            ),
          ),
        );
        assert.lengthOf(reads, 1);
        yield* Scope.close(scope, Exit.void);
        assert.equal(handlers.size, 0);
      }),
  );
});

describe("AgentBackendDiscoveryIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, object>;
  const requestId = "01991e60-b800-7000-8000-000000000012";
  const input = {
    scope: {
      kind: "project",
      instanceConfigId: "claude_DwwtN-gWKTuDgY0CipiA2mDkEAwUiZeUsBeQSfYr0Ks",
      projectId: "project",
    },
    requestId,
  };
  const makeEvent = (id: number) => {
    const mainFrame = { url: "http://localhost:5173/index.html" };
    let destroyed = false;
    const sender = Object.assign(new EventEmitter(), {
      id,
      mainFrame,
      getType: () => "window",
      isDestroyed: () => destroyed,
    });
    return {
      event: { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
      sender,
      destroy: () => {
        destroyed = true;
        sender.emit("destroyed");
      },
    };
  };

  it.effect(
    "typed discovery cancellation enforces viewer identity and window destruction releases the query",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const ipc = makeTestElectronIpc({
          handle: (channel, handler) =>
            Effect.acquireRelease(
              Effect.sync(() => handlers.set(channel, handler as Handler)),
              () => Effect.sync(() => handlers.delete(channel)),
            ).pipe(Effect.asVoid),
          on: () => Effect.void,
        });
        const firstAdmitted = yield* Deferred.make<void>();
        const secondAdmitted = yield* Deferred.make<void>();
        let acquisitions = 0;
        let releases = 0;
        const application = AgentBackendApplication.of({
          claudeDiscovery: () =>
            Effect.acquireRelease(
              Effect.gen(function* () {
                acquisitions++;
                yield* Deferred.succeed(
                  acquisitions === 1 ? firstAdmitted : secondAdmitted,
                  undefined,
                );
              }),
              () =>
                Effect.sync(() => {
                  releases++;
                }),
            ).pipe(Effect.andThen(Effect.never), Effect.scoped),
        } as unknown as AgentBackendApplication["Service"]);
        yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentBackendApplication, application),
                Layer.succeed(ElectronIpc, ipc),
                mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
                Layer.succeed(
                  WindowRuntime,
                  WindowRuntime.of({
                    has: (id: number) => id === 1 || id === 2,
                  } as unknown as WindowRuntime["Service"]),
                ),
              ),
            ),
          ),
          yield* Effect.scope,
        );
        const discover = handlers.get("agent-backend:claude:discover")!;
        const cancel = handlers.get("agent-backend:claude:cancel-discovery")!;
        const first = makeEvent(1);
        const second = makeEvent(2);
        expect(Exit.isFailure(yield* Effect.exit(cancel(makeEvent(3).event, { requestId })))).toBe(
          true,
        );
        const query = yield* Effect.forkChild(discover(first.event, input));
        yield* Deferred.await(firstAdmitted);
        yield* cancel(second.event, { requestId });
        expect(releases).toBe(0);
        yield* cancel(first.event, { requestId });
        expect(Exit.isFailure(yield* Fiber.await(query))).toBe(true);
        expect(releases).toBe(1);
        expect(first.sender.listenerCount("destroyed")).toBe(0);
        const restarted = yield* Effect.forkChild(discover(first.event, input));
        yield* Deferred.await(secondAdmitted);
        first.destroy();
        expect(Exit.isFailure(yield* Fiber.await(restarted))).toBe(true);
        expect(releases).toBe(2);
        expect(first.sender.listenerCount("destroyed")).toBe(0);
      }).pipe(Effect.scoped),
  );
});

describe("AgentDiscoveryRequests", () => {
  it.effect(
    "cancellation belongs to the requesting viewer and closes acquisition before acknowledging",
    () =>
      Effect.gen(function* () {
        const requests = yield* makeAgentDiscoveryRequests;
        const admitted = yield* Deferred.make<void>();
        let released = false;
        const query = yield* Effect.forkChild(
          requests.run(
            1,
            "request",
            Effect.acquireRelease(Deferred.succeed(admitted, undefined), () =>
              Effect.sync(() => {
                released = true;
              }),
            ).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Deferred.await(admitted);
        yield* requests.cancel(2, "request");
        expect(released).toBe(false);
        yield* requests.cancel(1, "request");
        expect(released).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(query))).toBe(true);
        expect(yield* requests.run(1, "request", Effect.succeed("fresh"))).toBe("fresh");
        expect(
          Exit.isFailure(
            yield* Effect.exit(requests.run(2, "request", Effect.succeed("wrong viewer"))),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("early cancellation and scope shutdown do not leak pending requests", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const requests = yield* makeAgentDiscoveryRequests.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      let evaluated = false;
      yield* requests.cancel(1, "early");
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            requests.run(
              1,
              "early",
              Effect.sync(() => {
                evaluated = true;
              }),
            ),
          ),
        ),
      ).toBe(true);
      expect(evaluated).toBe(false);
      const admitted = yield* Deferred.make<void>();
      let released = false;
      const query = yield* Effect.forkChild(
        requests.run(
          1,
          "active",
          Effect.acquireRelease(Deferred.succeed(admitted, undefined), () =>
            Effect.sync(() => {
              released = true;
            }),
          ).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* Deferred.await(admitted);
      yield* Scope.close(scope, Exit.void);
      expect(released).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(query))).toBe(true);
      expect((yield* Effect.result(requests.run(1, "after-close", Effect.void)))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.scoped),
  );
});

describe("NativeSessionCatalogIpc", () => {
  const ANTIGRAVITY_ID = "13947d2e-5d5d-4ea8-8507-5d092b7c7e08";

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
    const state = {
      completed: false,
      preparationFailure: null as "validation" | "transport" | null,
      entries: [] as NativeSessionCatalogPage["entries"],
    };
    const importLookups: string[][] = [];
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
          return { nativeHome: "/native-home", entries: state.entries, nextCursor: null };
        }),
    });
    yield* Layer.buildWithScope(
      liveNativeSessionCatalogIpc.pipe(
        Layer.provide(
          Layer.mergeAll(
            mainConfigLayer(),
            Layer.succeed(ProjectWorkspace, {
              listProjectWindow: () => Effect.succeed({ items: [], nextCursor: null }),
            } as unknown as ProjectWorkspace["Service"]),
            Layer.succeed(NativeSessionCatalog, catalog),
            Layer.succeed(NativeAutomationImport, {
              catalog: Effect.succeed({ rows: [], cronConversationKeys: [] }),
              importSelection: () => Effect.die("Unexpected automation import"),
            }),
            Layer.succeed(AgentRuntimeApplication, {
              findNativeImports: ({ nativeThreadIds }: { nativeThreadIds: readonly string[] }) =>
                Effect.sync(() => {
                  importLookups.push([...nativeThreadIds]);
                  return nativeThreadIds
                    .filter((id) => id === "imported" || id === ANTIGRAVITY_ID)
                    .map((nativeSessionId) => ({
                      nativeSessionId,
                      importedSessionId: "copy-session",
                      importedThreadId: "copy-thread",
                    }));
                }),
              submitNativeImport: (
                input: NativeConversationImportInput,
                prepare: Effect.Effect<{ title: string; model: string | null }, unknown>,
                resolveProject: Effect.Effect<string | null, unknown>,
              ) =>
                Effect.gen(function* () {
                  if (!state.completed) {
                    const metadata = yield* prepare;
                    yield* resolveProject;
                    imported.push({ ...input, title: metadata.title, model: metadata.model });
                  }
                  return {
                    kind: "imported" as const,
                    sessionId: input.requestId,
                    threadId: "runtime-thread",
                    projectId: null,
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
            Layer.succeed(ApplicationSettings, {
              snapshot: () => Effect.succeed({ agentProfiles: [] }),
            } as unknown as ApplicationSettings["Service"]),
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
    return { list, listed, importNative, preview, prepared, imported, state, importLookups };
  });

  it.effect("finds imported copies for a page larger than one Runtime lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const entry = (nativeSessionId: string) => ({
          nativeSessionId,
          title: nativeSessionId,
          cwd: "/repo",
          updatedAt: 1,
        });
        fixture.state.entries = [
          ...Array.from({ length: 150 }, (_, index) => entry(`source-${index}`)),
          entry("imported"),
        ];
        const page = (yield* fixture.list(trustedEvent(), {
          backendKind: "codex",
        })) as NativeSessionCatalogPage;
        assert.deepEqual(
          fixture.importLookups.map((lookup) => lookup.length),
          [100, 51],
        );
        assert.equal(page.entries.length, 151);
        assert.equal(page.entries.at(-1)?.importedThreadId, "copy-thread");
        assert.isUndefined(page.entries[0]?.importedThreadId);
      }),
    ),
  );

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
            cwd: tmpdir(),
          };
          for (const malformed of [
            { ...input, requestId: "wrong" },
            { ...input, nativeSessionId: "wrong" },
            { ...input, cwd: " " },
            { ...input, expectedHome: "" },
            { ...input, acceptedAt: -1 },
            { ...input, title: "Untrusted title" },
            { ...input, projectId: "Untrusted destination" },
            { ...input, backendKind: "claude" },
            { ...input, instanceConfigId: "wrong" },
          ])
            assert.equal(
              (yield* fixture.importNative(trustedEvent(), malformed).pipe(Effect.result))._tag,
              "Failure",
            );
          assert.equal(
            (yield* fixture
              .importNative(trustedEvent({ subframe: true }), input)
              .pipe(Effect.result))._tag,
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
          cwd: tmpdir(),
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

  it.effect("validates Antigravity source selection and UUIDs and annotates copied rows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const id = ANTIGRAVITY_ID;
        const source = { backendKind: "antigravity", instanceConfigId: "agy" };
        const request = {
          ...source,
          nativeSessionId: id.toUpperCase(),
          requestId: "019d0000-0000-7000-8000-000000000002",
          acceptedAt: 1,
          expectedHome: "/native-home",
          cwd: tmpdir(),
        };
        yield* fixture.importNative(trustedEvent(), request);
        assert.equal(fixture.prepared[0]?.nativeSessionId, id);
        assert.equal(fixture.imported[0]?.instanceConfigId, "agy");
        const withoutInstance = { ...request, instanceConfigId: undefined };
        for (const invalid of [withoutInstance, { ...request, nativeSessionId: id + "A" }]) {
          assert.equal(
            (yield* fixture.importNative(trustedEvent(), invalid).pipe(Effect.result))._tag,
            "Failure",
          );
        }
        fixture.state.entries = [
          { nativeSessionId: id, title: "Copied", cwd: "/repo", updatedAt: 1 },
        ];
        const page = (yield* fixture.list(trustedEvent(), source)) as NativeSessionCatalogPage;
        assert.equal(page.entries[0]?.importedThreadId, "copy-thread");
        assert.equal(
          (yield* fixture.list(trustedEvent(), { backendKind: "antigravity" }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        yield* fixture.preview(trustedEvent(), { ...source, reference: id });
        assert.equal(
          (yield* fixture
            .preview(trustedEvent(), { backendKind: "antigravity", reference: id })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(fixture.prepared.length, 1);
      }),
    ),
  );
});
