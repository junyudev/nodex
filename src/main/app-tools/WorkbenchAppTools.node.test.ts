import { describe, expect } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import {
  type PresentationAnchor,
  type WorkbenchObservedTab,
  WORKBENCH_AGENT_CANCEL_CHANNEL,
  WORKBENCH_AGENT_REQUEST_CHANNEL,
  WorkbenchAgentRequestSchema,
  WorkbenchAgentCancelSchema,
  type WorkbenchAgentReply,
  type WorkbenchAgentRequest,
  type WorkbenchWindowReference,
  type WorkbenchRendererObservation,
  type WorkbenchSceneReference,
} from "../../shared/nodex-app-tools/workbench";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexTurnPresentation } from "../../host/TurnPresentation";
import { makeTestTurnPresentation } from "../codex-application/CodexTurnPresentation.test-support";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import {
  WorkbenchAgentBridge,
  make as makeWorkbenchAgentBridge,
  WorkbenchAgentBridgeError,
} from "./WorkbenchAgentBridge";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import {
  WorkbenchObservation,
  type WorkbenchObservationRecord,
  make as makeWorkbenchObservation,
  type WorkbenchObservationPrincipal,
} from "./WorkbenchObservation";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./WorkbenchAppTools";
import { createHostedAppToolCaller } from "./AppToolCaller";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import type { WorkbenchCommandEnvelope } from "../../shared/nodex-app-tools/workbench-commands";
import { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import {
  workbenchObservationHandle,
  readWorkbenchObservationPage,
} from "./workbench-observation-page";
import { make as makeWorkbenchControl } from "./WorkbenchControl";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import type { WindowRuntimeLifecycleEvent } from "../window-runtime/window-runtime-lifecycle";
import { it as itworkbenchobservationpage } from "vitest";
import { make as makeWorkbenchTabDescription } from "./WorkbenchTabDescription";

describe("WorkbenchAppTools", () => {
  const authority: NodexAgentTurnContext = {
    threadId: "thread",
    turnId: "turn",
    rootThreadId: "thread",
    actorProjectId: "project",
    libraryId: "library",
    storeEpoch: "epoch",
    admittedAtMs: 1,
  };
  const tab: WorkbenchObservedTab = {
    tabId: "page:secret",
    panelId: "right",
    groupId: "group",
    protected: false,
    persisted: true,
    preview: false,
    selected: true,
    visible: true,
    auxiliary: null,
    surface: {
      id: "page:secret",
      kind: "page_stage",
      titleSnapshot: "Renderer secret",
      config: { pageId: "page-A" },
    },
  };
  const anchor: PresentationAnchor = {
    windowSessionId: "window",
    rendererGeneration: "generation",
    sceneOwner: { kind: "project", projectId: "project" },
    presentationRevision: 1,
    focusedTarget: null,
    selectedTabs: [tab],
    capturedAt: "2026-09-08T00:00:00.000Z",
  };
  const record: WorkbenchObservationRecord = {
    observationId: "00000000-0000-4000-8000-000000000001",
    capturedAt: anchor.capturedAt,
    expiresAt: "2026-09-08T00:01:00.000Z",
    reference: {
      windowSessionId: anchor.windowSessionId,
      rendererGeneration: anchor.rendererGeneration,
      sceneOwner: anchor.sceneOwner!,
    },
    observation: {
      sceneOwner: anchor.sceneOwner!,
      selectedSceneOwner: anchor.sceneOwner,
      presentationRevision: 1,
      mounted: true,
      focusedTarget: null,
      tabs: [tab],
      groups: [],
      panels: [],
      splits: [],
    },
  };
  const input: AppToolInvocation = {
    name: "get_session_context",
    arguments: {},
    caller: {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      hostId: "local",
      generation: 1,
      isActive: () => true,
    },
  };

  const setup = (
    options: {
      unavailable?: boolean;
      changed?: boolean;
      titleChanged?: boolean;
      withdraw?: () => void;
      anchor?: PresentationAnchor;
      presentation?: CodexTurnPresentation["Service"];
    } = {},
  ) =>
    make.pipe(
      Effect.provideService(TerminalSessions, {} as never),
      Effect.provideService(GitWorkerRuntime, {} as never),
      Effect.provideService(NodexAgentApplication, {} as never),
      Effect.provideService(CoreModules, {} as never),
      Effect.provideService(CodexTurnAuthority, {
        capture: () => Effect.succeed(authority),
      } as never),
      Effect.provideService(
        CodexTurnPresentation,
        options.presentation ?? ({ read: () => options.anchor ?? anchor } as never),
      ),
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(ProjectWorkspace, {
        getThread: () =>
          Effect.succeed({
            sessionId: "session",
            projectId: "project",
            cwd: "/project",
            executionHostId: "local",
          }),
      } as never),
      Effect.provideService(WorkbenchAgentBridge, { registered: () => [] } as never),
      Effect.provideService(NodexAppToolAuthority, {
        bind: () => Effect.succeed({ authority }),
      } as never),
      Effect.provideService(WorkbenchObservation, {
        capture: () =>
          Effect.succeed(
            options.changed
              ? {
                  ...record,
                  observation: {
                    ...record.observation,
                    presentationRevision: 2,
                    tabs: [
                      {
                        ...tab,
                        surface: {
                          ...tab.surface!,
                          kind: "page_stage",
                          config: { pageId: "page-B" },
                        },
                      },
                    ],
                  },
                }
              : options.titleChanged
                ? {
                    ...record,
                    observation: {
                      ...record.observation,
                      presentationRevision: 2,
                      tabs: [{ ...tab, surface: { ...tab.surface!, titleSnapshot: "Renamed" } }],
                    },
                  }
                : record,
          ),
        resolve: () => Effect.succeed(record),
      } as never),
      Effect.provideService(WorkbenchContentRouting, {
        describe: (request: { surface: { config: { pageId: string } } }) =>
          Effect.sync(() => {
            options.withdraw?.();
            return options.unavailable
              ? { status: "unavailable" }
              : {
                  status: "available",
                  kind: "page",
                  pageId: request.surface.config.pageId,
                  libraryId: "library",
                  title: "Canonical title",
                  displayedRoutingContext: { kind: "library" },
                };
          }),
      } as never),
    );

  it.effect("describes missing content without a resource identity", () =>
    Effect.gen(function* () {
      const execute = yield* setup({ unavailable: true });
      const result = yield* execute(input);
      assert.strictEqual(result.isError, undefined);
      const described = (
        result.structuredContent?.presentation as { selectedTabs: Record<string, unknown>[] }
      ).selectedTabs[0]!;
      assert.equal(described.status, "unavailable");
      assert.notProperty(described, "pageId");
      assert.notProperty(described, "title");
    }),
  );

  it.effect(
    "keeps the submitted Page after the same tab changes targets and removes its actionable handle",
    () =>
      Effect.gen(function* () {
        const execute = yield* setup({ changed: true });
        const result = yield* execute(input);
        const presentation = result.structuredContent!.presentation as {
          selectedTabs: Record<string, unknown>[];
          changedSinceSubmission: boolean;
        };
        assert.strictEqual(presentation.changedSinceSubmission, true);
        assert.strictEqual(presentation.selectedTabs[0]!.pageId, "page-A");
        assert.strictEqual(presentation.selectedTabs[0]!.tabId, null);
        assert.strictEqual(presentation.selectedTabs[0]!.targetState, "changed");
      }),
  );

  it.effect("withdraws an authorized result when the caller ends during content resolution", () =>
    Effect.gen(function* () {
      let active = true;
      const execute = yield* setup({
        withdraw: () => {
          active = false;
        },
      });
      const result = yield* execute({
        ...input,
        caller: { ...input.caller, isActive: () => active },
      });
      assert.deepStrictEqual(result.structuredContent, {
        error: { code: "authority_unavailable" },
      });
    }),
  );

  it.effect("does not resolve an unhydrated submitted default against a later default View", () =>
    Effect.gen(function* () {
      const execute = yield* setup({
        anchor: {
          ...anchor,
          selectedTabs: [
            {
              ...tab,
              surface: {
                id: "view",
                kind: "db_view",
                titleSnapshot: "Default",
                config: {
                  routingContext: { kind: "project", projectId: "project" },
                  target: { kind: "project-default" },
                },
              },
            },
          ],
        },
      });
      const result = yield* execute(input);
      const presentation = result.structuredContent!.presentation as {
        selectedTabs: Record<string, unknown>[];
      };
      assert.strictEqual(presentation.selectedTabs[0]!.status, "unavailable");
      assert.strictEqual(Object.hasOwn(presentation.selectedTabs[0]!, "viewId"), false);
    }),
  );

  it.effect("keeps a submitted target actionable after only its title changes", () =>
    Effect.gen(function* () {
      const execute = yield* setup({ titleChanged: true });
      const result = yield* execute(input);
      const context = result.structuredContent?.presentation as {
        selectedTabs: Record<string, unknown>[];
        changedSinceSubmission: boolean;
      };
      assert.isTrue(context.changedSinceSubmission);
      assert.equal(context.selectedTabs[0]?.targetState, "present");
      assert.isString(context.selectedTabs[0]?.tabId);
      assert.equal(context.selectedTabs[0]?.pageId, "page-A");
    }),
  );

  it.effect(
    "Session-only native actors expose Session context without a fabricated Turn focus",
    () =>
      Effect.gen(function* () {
        const execute = yield* setup();
        const caller = createHostedAppToolCaller({
          backend: "acp",
          authority,
          callId: "call",
          generation: 1,
          isActive: () => true,
          capture: Effect.succeed(authority),
          sessionContext: {
            sessionId: "session",
            projectId: "project",
            runtimeId: "runtime",
            rootThreadId: "root",
            threadId: "thread",
            runId: null,
            cwd: "/worktree",
          },
        });
        const result = yield* execute({ ...input, caller });
        assert.isUndefined(result.isError);
        assert.equal(result.structuredContent?.sessionId, "session");
        assert.isNull(result.structuredContent?.runId);
        assert.notProperty(result.structuredContent, "turnId");
        assert.deepEqual(result.structuredContent?.presentation, {
          status: "unavailable",
          candidates: [],
        });
      }),
  );

  it.effect(
    "reads the submitted Scene using the Runtime Run rather than Core lease coordinates",
    () =>
      Effect.gen(function* () {
        const presentation = yield* makeTestTurnPresentation;
        const target = { kind: "session", sessionId: "session", launchId: "launch" } as const;
        const ticket = yield* presentation.capture(11, {
          target,
          presentation: {
            rendererGeneration: "renderer-a",
            sceneOwner: anchor.sceneOwner,
            presentationRevision: anchor.presentationRevision,
            focusedTarget: anchor.focusedTarget,
            selectedTabs: anchor.selectedTabs,
          },
        });
        yield* presentation.admitRuntimeMessage(ticket, target, "engine-thread", "message");
        yield* presentation.observeRuntimeMessage("engine-thread", "engine-run", "message", {
          runtimeId: "runtime",
          runtimeGeneration: "lease",
          providerSessionId: "native",
          nativeGeneration: 1,
        });
        const hostedAuthority = {
          ...authority,
          threadId: "engine-thread",
          turnId: "engine-run",
          runtime: { sessionId: "session", runtimeId: "runtime", turnKind: "run" as const },
        };
        const caller = createHostedAppToolCaller({
          backend: "codex",
          authority: hostedAuthority,
          callId: "call",
          generation: 1,
          isActive: () => true,
          capture: Effect.succeed(hostedAuthority),
          sessionContext: {
            sessionId: "session",
            projectId: "project",
            runtimeId: "runtime",
            rootThreadId: "engine-thread",
            threadId: "engine-thread",
            runId: "engine-run",
            cwd: "/workspace",
          },
        });
        const execute = yield* setup({ presentation });
        const result = yield* execute({ ...input, caller });
        const observed = result.structuredContent?.presentation as {
          selectedTabs: Record<string, unknown>[];
        };
        assert.isUndefined(result.isError);
        assert.equal(result.structuredContent?.threadId, "engine-thread");
        assert.equal(result.structuredContent?.runId, "engine-run");
        assert.equal(observed.selectedTabs[0]?.pageId, "page-A");
      }),
  );
});

describe("WorkbenchControl", () => {
  const make = makeWorkbenchControl;
  const authority: NodexAgentTurnContext = {
    threadId: "thread",
    turnId: "turn",
    rootThreadId: "thread",
    actorProjectId: "project",
    libraryId: "library",
    storeEpoch: "epoch",
    admittedAtMs: 1,
  };
  const observationId = "00000000-0000-4000-8000-000000000001";
  const record: WorkbenchObservationRecord = {
    observationId,
    capturedAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-08T00:01:00.000Z",
    reference: {
      windowSessionId: "window",
      rendererGeneration: "generation",
      sceneOwner: { kind: "library" },
    },
    observation: {
      sceneOwner: { kind: "library" },
      selectedSceneOwner: { kind: "library" },
      presentationRevision: 7,
      mounted: true,
      focusedTarget: null,
      panels: [],
      splits: [],
      groups: [
        {
          groupId: "raw-group",
          panelId: "right",
          tabIds: ["raw-page-id"],
          selectedTabId: "raw-page-id",
          focused: true,
          visible: true,
        },
      ],
      tabs: [
        {
          tabId: "raw-page-id",
          panelId: "right",
          groupId: "raw-group",
          protected: false,
          persisted: true,
          preview: false,
          selected: true,
          visible: true,
          auxiliary: null,
          surface: {
            id: "raw-page-id",
            titleSnapshot: "Page",
            kind: "page_stage",
            config: { pageId: "page" },
          },
        },
      ],
    },
  };
  const context = {
    invocation: {
      name: "close_tab",
      arguments: {
        observationId,
        tabId: workbenchObservationHandle(observationId, "tab", "raw-page-id"),
        idempotencyKey: "retry",
      },
      caller: {
        threadId: "thread",
        turnId: "turn",
        callId: "call",
        hostId: "local",
        generation: 1,
        isActive: () => true,
      },
    },
    principal: {
      profileId: "profile",
      authorityFingerprint: "authority",
      hostId: "local",
      backendGeneration: 1,
    },
    authority,
    isCurrent: Effect.succeed(true),
  };
  const setup = (requests: WorkbenchCommandEnvelope[], snapshot = record) =>
    make.pipe(
      Effect.provideService(CoreModules, createAppToolAdmissionFixture().core),
      Effect.provideService(WorkbenchObservation, {
        forCommand: () => Effect.succeed(snapshot),
      } as never),
      Effect.provideService(WorkbenchAgentBridge, {
        request: (_reference: unknown, request: { envelope: WorkbenchCommandEnvelope }) =>
          Effect.sync(() => {
            requests.push(request.envelope);
            return {
              kind: "command",
              receipt: {
                operationId: request.envelope.operationId,
                sceneOwner: record.reference.sceneOwner,
                applied: true,
                persisted: true,
                presentationRevision: 8,
                layoutRevision: 3,
                tabId: "raw-page-id",
                groupId: "raw-group",
                error: null,
              },
            };
          }),
      } as never),
      Effect.provideService(WorkbenchContentRouting, {
        describe: () =>
          Effect.succeed({
            status: "available",
            kind: "page",
            pageId: "page",
            title: "Page",
            libraryId: "library",
            displayedRoutingContext: { kind: "library" },
          }),
      } as never),
      Effect.provideService(ProjectWorkspace, {} as never),
    );

  it.effect(
    "translates opaque handles and preserves the original revision and operation on exact retries",
    () =>
      Effect.gen(function* () {
        const requests: WorkbenchCommandEnvelope[] = [];
        const execute = yield* setup(requests);
        const first = yield* execute(context);
        const second = yield* execute(context);
        assert.deepStrictEqual(requests[0], {
          operationId: String(first.structuredContent?.operationId),
          sceneOwner: { kind: "library" },
          expectedPresentationRevision: 7,
          command: { kind: "close_tab", tabId: "raw-page-id" },
        });
        assert.deepStrictEqual(requests[1], requests[0]);
        assert.deepStrictEqual(second, first);
        assert.strictEqual(first.structuredContent!.refreshRequired, true);
        assert.strictEqual(Object.hasOwn(first.structuredContent!, "tabId"), false);
      }),
  );

  it.effect(
    "rejects raw handles, read-only turns and withdrawn authority before renderer dispatch",
    () =>
      Effect.gen(function* () {
        const requests: WorkbenchCommandEnvelope[] = [];
        const execute = yield* setup(requests);
        const invalid = yield* execute({
          ...context,
          invocation: {
            ...context.invocation,
            arguments: {
              ...context.invocation.arguments,
              idempotencyKey: "invalid-handle",
              tabId: "raw-page-id",
            },
          },
        });
        assert.strictEqual(invalid.isError, true);
        const withdrawn = yield* execute({ ...context, isCurrent: Effect.succeed(false) });
        assert.deepStrictEqual(withdrawn.structuredContent, {
          error: { code: "authority_unavailable" },
        });
        assert.strictEqual(requests.length, 0);
        const otherProject = yield* setup(requests, {
          ...record,
          reference: { ...record.reference, sceneOwner: { kind: "project", projectId: "other" } },
        });
        assert.isFalse((yield* otherProject(context)).isError ?? false);
        assert.equal(requests.length, 1);
      }),
  );

  it("accepts semantic open targets while rejecting runtime identity and arbitrary descriptor injection", () => {
    const input = {
      observationId,
      panelId: "right",
      groupId: "group",
      target: { kind: "browser", url: "https://example.com" },
    };
    assert.strictEqual(workbenchControlSchemas.open_tab.safeParse(input).success, true);
    assert.strictEqual(
      workbenchControlSchemas.open_tab.safeParse({
        ...input,
        target: { ...input.target, browserStorageId: "other" },
      }).success,
      false,
    );
    assert.strictEqual(
      workbenchControlSchemas.open_tab.safeParse({
        ...input,
        target: { kind: "browser", url: "javascript:alert(1)" },
      }).success,
      false,
    );
  });

  it("accepts a side-only panel change and rejects unknown sides and empty requests", () => {
    const input = { observationId, panelId: "right", side: "left" };
    assert.strictEqual(workbenchControlSchemas.set_panel_state.safeParse(input).success, true);
    assert.strictEqual(
      workbenchControlSchemas.set_panel_state.safeParse({ ...input, side: "right" }).success,
      true,
    );
    assert.strictEqual(
      workbenchControlSchemas.set_panel_state.safeParse({ ...input, side: "up" }).success,
      false,
    );
    assert.strictEqual(
      workbenchControlSchemas.set_panel_state.safeParse({ observationId, panelId: "right" })
        .success,
      false,
    );
  });

  it.effect("forwards Session physical side through the panel command adapter", () =>
    Effect.gen(function* () {
      const requests: WorkbenchCommandEnvelope[] = [];
      const execute = yield* setup(requests, {
        ...record,
        reference: { ...record.reference, sceneOwner: { kind: "session", sessionId: "session" } },
      });
      const result = yield* execute({
        ...context,
        invocation: {
          ...context.invocation,
          name: "set_panel_state",
          arguments: { observationId, panelId: "right", side: "left" },
        },
      });
      assert.isFalse(result.isError ?? false);
      assert.deepStrictEqual(requests[0]?.command, {
        kind: "set_panel_state",
        panelId: "right",
        side: "left",
        collapsed: undefined,
        size: undefined,
      });
    }),
  );
});

describe("WorkbenchAgentBridge", () => {
  const make = makeWorkbenchAgentBridge;
  const setup = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const events = yield* PubSub.sliding<WindowRuntimeLifecycleEvent>(32);
    const state = new Map(
      [11, 22].map((id) => [
        id,
        {
          generation: `document-${id}`,
          ownerId: null as string | null,
          windowSessionId: `window-${id}`,
        },
      ]),
    );
    const sent: Array<{ id: number; channel: string; value: WorkbenchAgentRequest }> = [];
    const throttling: Array<readonly [id: number, throttled: boolean]> = [];
    const runtime = WindowRuntime.of({
      events: Stream.fromPubSub(events),
      resolveSessionId: (id: number) => state.get(id)?.windowSessionId ?? null,
      resolveRendererGeneration: (id: number) => state.get(id)?.generation ?? null,
      claimPresentationGeneration: (id: number, ownerId: string) => {
        const entry = state.get(id);
        if (!entry) return null;
        if (entry.ownerId !== null && entry.ownerId !== ownerId) entry.generation += ":replacement";
        entry.ownerId = ownerId;
        return entry.generation;
      },
      get: (id: number) => ({
        isDestroyed: () => !state.has(id),
        webContents: {
          id,
          setBackgroundThrottling: (throttled: boolean) => throttling.push([id, throttled]),
        },
      }),
    } as unknown as WindowRuntime["Service"]);
    const context = yield* Layer.buildWithScope(
      Layer.effect(
        WorkbenchAgentBridge,
        make({
          maxPending: 2,
          maxPendingPerWindow: 1,
          timeoutMs: 1_000,
          send: (window, channel, args) => {
            assert.isNumber(window?.webContents.id);
            const schema =
              channel === WORKBENCH_AGENT_REQUEST_CHANNEL
                ? WorkbenchAgentRequestSchema
                : WorkbenchAgentCancelSchema;
            assert.isTrue(schema.safeParse(args?.[0]).success);
            sent.push({
              id: window!.webContents.id!,
              channel,
              value: args?.[0] as WorkbenchAgentRequest,
            });
            return true;
          },
        }),
      ).pipe(Layer.provide(Layer.succeed(WindowRuntime, runtime))),
      scope,
    );
    const bridge = Context.get(context, WorkbenchAgentBridge);
    const first = yield* bridge.register(11, "owner-11");
    const second = yield* bridge.register(22, "owner-22");
    const replace = (id: number) => {
      const entry = state.get(id)!;
      const previousRendererGeneration = entry.generation;
      entry.generation += ":next";
      PubSub.publishUnsafe(events, {
        kind: "renderer-changed",
        reason: "navigation-committed",
        previousRendererGeneration,
        revision: 1,
        window: {
          kind: "primary",
          webContentsId: id,
          windowId: id,
          windowSessionId: entry.windowSessionId,
          rendererGeneration: entry.generation,
          activeSessionId: null,
          layoutRevision: 0,
          focusSequence: null,
          focused: false,
        },
      });
    };
    return {
      bridge,
      scope,
      sent,
      first: { ...first, sceneOwner: { kind: "library" as const } },
      second,
      replace,
      state,
      throttling,
    };
  });

  const response = (
    request: WorkbenchAgentRequest,
    reference: WorkbenchWindowReference = request,
  ): WorkbenchAgentReply => ({
    windowSessionId: reference.windowSessionId,
    rendererGeneration: reference.rendererGeneration,
    requestId: request.requestId,
    outcome: { ok: true, result: { kind: "observe", observation: null } },
  });

  it.effect("correlates observations to the exact window, renderer, and request kind", () =>
    Effect.gen(function* () {
      const subject = yield* setup;
      const request = yield* subject.bridge
        .request(subject.first, { kind: "observe", sceneOwner: { kind: "library" } })
        .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
      yield* Effect.yieldNow;
      const message = subject.sent.find(
        (item) => item.channel === WORKBENCH_AGENT_REQUEST_CHANNEL,
      )!.value;
      assert.deepEqual(
        subject.sent.map((item) => item.id),
        [11],
      );
      assert.isFalse(yield* subject.bridge.reply(22, response(message)));
      assert.isFalse(yield* subject.bridge.reply(11, response(message, subject.second)));
      assert.isFalse(
        yield* subject.bridge.reply(11, {
          ...response(message),
          outcome: {
            ok: true,
            result: {
              kind: "discover",
              presentationRevision: 0,
              selectedSceneOwner: null,
              sceneOwners: [],
            },
          },
        }),
      );
      assert.isTrue(yield* subject.bridge.reply(11, response(message)));
      assert.deepEqual(yield* Fiber.join(request), { kind: "observe", observation: null });
      assert.isFalse(yield* subject.bridge.reply(11, response(message)));
      assert.equal(subject.sent.length, 1);
      yield* Scope.close(subject.scope, Exit.void);
    }),
  );

  it.effect(
    "withdraws pending work on renderer replacement and rejects delayed replies and release",
    () =>
      Effect.gen(function* () {
        const subject = yield* setup;
        const request = yield* subject.bridge
          .request(subject.first, { kind: "observe", sceneOwner: { kind: "library" } })
          .pipe(Effect.flip, Effect.forkIn(subject.scope, { startImmediately: true }));
        yield* Effect.yieldNow;
        const message = subject.sent[0]!.value;
        subject.replace(11);
        assert.isNull(subject.bridge.referenceForSender(11));
        assert.isFalse(yield* subject.bridge.reply(11, response(message)));
        assert.equal((yield* Fiber.join(request)).reason, "stale_renderer");
        const replacement = yield* subject.bridge.register(11, "replacement-owner");
        yield* subject.bridge.release(11, subject.first);
        assert.deepEqual(subject.bridge.referenceForSender(11), replacement);
        assert.deepEqual(subject.bridge.referenceForSender(22), subject.second);
        assert.equal(
          (yield* subject.bridge
            .request(subject.first, { kind: "discover", sessionId: "session" })
            .pipe(Effect.flip)).reason,
          "stale_renderer",
        );
        const afterReload = yield* subject.bridge
          .request(replacement, { kind: "observe", sceneOwner: { kind: "library" } })
          .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
        yield* Effect.yieldNow;
        assert.isTrue(yield* subject.bridge.reply(11, response(subject.sent.at(-1)!.value)));
        assert.deepEqual(yield* Fiber.join(afterReload), { kind: "observe", observation: null });
        yield* Scope.close(subject.scope, Exit.void);
      }),
  );

  it.effect("bounds pending requests and frees capacity on timeout and caller cancellation", () =>
    Effect.gen(function* () {
      const subject = yield* setup;
      const request = yield* subject.bridge
        .request(subject.first, { kind: "observe", sceneOwner: { kind: "library" } })
        .pipe(Effect.flip, Effect.forkIn(subject.scope, { startImmediately: true }));
      yield* Effect.yieldNow;
      assert.equal(
        (yield* subject.bridge
          .request(subject.first, { kind: "discover", sessionId: "session" })
          .pipe(Effect.flip)).reason,
        "capacity",
      );
      yield* TestClock.adjust(1_000);
      assert.equal((yield* Fiber.join(request)).reason, "timeout");
      assert.equal(
        subject.sent.filter((item) => item.channel === WORKBENCH_AGENT_CANCEL_CHANNEL).length,
        1,
      );
      const cancelled = yield* subject.bridge
        .request(subject.first, { kind: "observe", sceneOwner: { kind: "library" } })
        .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(cancelled);
      assert.equal(
        subject.sent.filter((item) => item.channel === WORKBENCH_AGENT_CANCEL_CHANNEL).length,
        2,
      );
      const finalRequest = yield* subject.bridge
        .request(subject.first, { kind: "observe", sceneOwner: { kind: "library" } })
        .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isTrue(yield* subject.bridge.reply(11, response(subject.sent.at(-1)!.value)));
      yield* Fiber.join(finalRequest);
      // A hidden window answers at full speed while a request waits, whichever way it settles.
      const settled = [
        [11, false],
        [11, true],
      ] as const;
      assert.deepEqual(subject.throttling, [...settled, ...settled, ...settled]);
      yield* Scope.close(subject.scope, Exit.void);
      assert.deepEqual(subject.bridge.registered(), []);
      assert.equal(
        (yield* subject.bridge.register(11, "late-owner").pipe(Effect.flip)).reason,
        "closed",
      );
    }),
  );
});

describe("WorkbenchObservation", () => {
  const make = makeWorkbenchObservation;
  describe("WorkbenchObservation", () => {
    const principal: WorkbenchObservationPrincipal = {
      profileId: "profile",
      authorityFingerprint: "exact-frozen-turn",
      hostId: "local",
      backendGeneration: 1,
    };
    const reference: WorkbenchSceneReference = {
      windowSessionId: "window-A",
      rendererGeneration: "renderer-A",
      sceneOwner: { kind: "session", sessionId: "session" },
    };
    const observation: WorkbenchRendererObservation = {
      sceneOwner: reference.sceneOwner,
      selectedSceneOwner: reference.sceneOwner,
      presentationRevision: 3,
      mounted: true,
      focusedTarget: { tabId: "page-tab", panelId: "right", groupId: "right-group" },
      tabs: [
        {
          tabId: "page-tab",
          panelId: "right",
          groupId: "right-group",
          protected: false,
          persisted: true,
          preview: false,
          selected: true,
          visible: true,
          surface: {
            id: "page-tab",
            kind: "page_stage",
            titleSnapshot: "Original Page",
            config: { pageId: "page-A" },
          },
          auxiliary: null,
        },
      ],
      groups: [
        {
          groupId: "right-group",
          panelId: "right",
          tabIds: ["page-tab"],
          selectedTabId: "page-tab",
          focused: true,
          visible: true,
        },
      ],
      panels: [
        {
          panelId: "right",
          collapsed: false,
          activeGroupId: "right-group",
          maximizedGroupId: null,
          size: {},
        },
        {
          panelId: "bottom",
          collapsed: true,
          activeGroupId: "bottom-group",
          maximizedGroupId: null,
          size: {},
        },
      ],
      splits: [],
    };

    const setup = (options: Parameters<typeof make>[0] = {}) =>
      Effect.gen(function* () {
        let current = structuredClone(observation);
        let generation = reference.rendererGeneration;
        let requests = 0;
        const owner = yield* make(options).pipe(
          Effect.provideService(WorkbenchAgentBridge, {
            request: (target: WorkbenchSceneReference) =>
              Effect.gen(function* () {
                requests += 1;
                if (target.rendererGeneration !== generation)
                  return yield* new WorkbenchAgentBridgeError({ reason: "stale_renderer" });
                return { kind: "observe", observation: current } as const;
              }),
          } as unknown as WorkbenchAgentBridge["Service"]),
        );
        return {
          owner,
          change: (next: WorkbenchRendererObservation) => {
            current = next;
          },
          reload: () => {
            generation = "renderer-reloaded";
          },
          requests: () => requests,
        };
      });

    it.effect(
      "binds immutable observations to the exact caller, Profile, backend, and renderer",
      () =>
        Effect.gen(function* () {
          const subject = yield* setup();
          const captured = yield* subject.owner.capture(principal, reference);
          for (const different of [
            { ...principal, profileId: "other-profile" },
            { ...principal, authorityFingerprint: "other-turn" },
            { ...principal, hostId: "remote" },
            { ...principal, backendGeneration: 2 },
          ]) {
            assert.equal(
              (yield* subject.owner.resolve(different, captured.observationId).pipe(Effect.flip))
                .reason,
              "observation_unavailable",
            );
          }
          assert.equal(subject.requests(), 1);
          const returnedSurface = captured.observation.tabs[0]!.surface!;
          Object.assign(returnedSurface, { titleSnapshot: "Changed by consumer" });
          const resolved = yield* subject.owner.resolve(principal, captured.observationId);
          assert.equal(resolved.observation.tabs[0]!.surface!.titleSnapshot, "Original Page");
          subject.reload();
          assert.equal(
            (yield* subject.owner.resolve(principal, captured.observationId).pipe(Effect.flip))
              .reason,
            "stale_renderer",
          );
        }).pipe(Effect.scoped),
    );

    it.effect("rejects an old UI referent after a preview or Scene revision changes", () =>
      Effect.gen(function* () {
        const subject = yield* setup();
        const captured = yield* subject.owner.capture(principal, reference);
        subject.change({ ...observation, presentationRevision: 4, tabs: [] });
        assert.equal(
          (yield* subject.owner.resolve(principal, captured.observationId).pipe(Effect.flip))
            .reason,
          "stale_presentation",
        );
        assert.equal(
          (yield* subject.owner.resolve(principal, captured.observationId).pipe(Effect.flip))
            .reason,
          "observation_unavailable",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("bounds retention by caller, total count, expiry, and complete encoded size", () =>
      Effect.gen(function* () {
        const subject = yield* setup({ maxPerCaller: 1, maxRecords: 2, lifetimeMs: 60_000 });
        const evicted = yield* subject.owner.capture(principal, reference);
        const retained = yield* subject.owner.capture(principal, reference);
        assert.equal(
          (yield* subject.owner.resolve(principal, evicted.observationId).pipe(Effect.flip)).reason,
          "observation_unavailable",
        );
        yield* subject.owner.capture(
          { ...principal, authorityFingerprint: "second-turn" },
          reference,
        );
        yield* subject.owner.capture(
          { ...principal, authorityFingerprint: "third-turn" },
          reference,
        );
        assert.equal(
          (yield* subject.owner.resolve(principal, retained.observationId).pipe(Effect.flip))
            .reason,
          "observation_unavailable",
        );
        const expiring = yield* subject.owner.capture(principal, reference);
        yield* TestClock.adjust(60_000);
        assert.equal(
          (yield* subject.owner.resolve(principal, expiring.observationId).pipe(Effect.flip))
            .reason,
          "observation_unavailable",
        );
        const small = yield* setup({ maxBytes: 1 });
        assert.equal(
          (yield* small.owner.capture(principal, reference).pipe(Effect.flip)).reason,
          "result_too_large",
        );
      }).pipe(Effect.scoped),
    );
  });

  describe("workbench-observation-page", () => {
    const it = itworkbenchobservationpage;
    describe("Workbench observation pagination", () => {
      it("binds continuation to the observation, collection and filters", () => {
        const input = {
          observationId: "observation",
          kind: "tabs" as const,
          panelId: "right" as const,
          groupId: "group",
          limit: 2,
        };
        const first = readWorkbenchObservationPage([1, 2, 3], input)!;
        expect(first.items).toEqual([1, 2]);
        expect(first.complete).toBe(false);
        const continued = { ...input, cursor: first.nextCursor! };
        expect(readWorkbenchObservationPage([1, 2, 3], continued)).toEqual({
          items: [3],
          nextCursor: null,
          total: 3,
          complete: true,
        });
        for (const changed of [
          { observationId: "other" },
          { kind: "groups" as const },
          { panelId: "bottom" as const },
          { groupId: "other" },
        ])
          expect(readWorkbenchObservationPage([1, 2, 3], { ...continued, ...changed })).toBeNull();
        expect(
          readWorkbenchObservationPage([1, 2, 3], { ...continued, cursor: `${first.nextCursor}x` }),
        ).toBeNull();
      });

      it("does not expose embedded resource identities through tab handles", () => {
        const internal = "page:private-page-id";
        const handle = workbenchObservationHandle("one", "tab", internal);
        expect(handle).not.toContain(internal);
        expect(workbenchObservationHandle("one", "tab", internal)).toBe(handle);
        expect(workbenchObservationHandle("two", "tab", internal)).not.toBe(handle);
        expect(workbenchObservationHandle("one", "group", internal)).not.toBe(handle);
      });
    });
  });
});

describe("WorkbenchTabDescription", () => {
  const make = makeWorkbenchTabDescription;
  const tab: WorkbenchObservedTab = {
    tabId: "surface",
    panelId: "right",
    groupId: "group",
    protected: false,
    persisted: true,
    preview: false,
    selected: true,
    visible: true,
    auxiliary: null,
    surface: {
      id: "surface",
      kind: "page_file",
      titleSnapshot: "Stale",
      config: {
        pageId: "page",
        fileId: "file",
        logicalPath: "old.html",
      },
    },
  };
  it.effect(
    "describes a Page File with canonical Page and File metadata and redacts unavailable content",
    () =>
      Effect.gen(function* () {
        for (const available of [true, false]) {
          const describe = yield* make.pipe(
            Effect.provideService(WorkbenchContentRouting, {
              describe: () => Effect.succeed({ status: "unavailable" }),
              describePageFile: () =>
                Effect.succeed(
                  available
                    ? {
                        status: "available",
                        kind: "page_file",
                        title: "report.html",
                        libraryId: "library",
                        displayedRoutingContext: { kind: "library" },
                        pageId: "page",
                        pageTitle: "Report",
                        fileId: "file",
                        logicalPath: "output/report.html",
                      }
                    : { status: "unavailable" },
                ),
            }),
          );
          const result = yield* describe({
            observationId: "observation",
            tab,
            sceneOwner: { kind: "library" },
            authority: {} as NodexAgentTurnContext,
            callId: "call",
          });
          if (available) {
            assert.equal(result.kind, "page_file");
            assert.equal(result.pageId, "page");
            assert.equal(result.pageTitle, "Report");
            assert.equal(result.fileId, "file");
            assert.equal(result.logicalPath, "output/report.html");
            assert.equal(result.title, "report.html");
          } else {
            assert.equal(result.status, "unavailable");
            assert.notProperty(result, "pageId");
            assert.notProperty(result, "fileId");
            assert.notProperty(result, "title");
          }
        }
      }),
  );

  it.effect("describes a skill tab with its name and manifest path", () =>
    Effect.gen(function* () {
      const describe = yield* make.pipe(
        Effect.provideService(WorkbenchContentRouting, {
          describe: () => Effect.succeed({ status: "unavailable" }),
          describePageFile: () => Effect.succeed({ status: "unavailable" }),
        }),
      );
      const result = yield* describe({
        observationId: "observation",
        tab: {
          ...tab,
          surface: {
            id: "surface",
            kind: "skill",
            titleSnapshot: "inspect",
            config: {
              hostId: "local",
              projectId: null,
              skillId: "inspect-id",
              manifestPath: "/skills/inspect/SKILL.md",
            },
          },
        },
        sceneOwner: { kind: "library" },
        authority: {} as NodexAgentTurnContext,
        callId: "call",
      });
      assert.equal(result.status, "available");
      assert.equal(result.kind, "skill");
      assert.equal(result.title, "inspect");
      assert.equal(result.path, "/skills/inspect/SKILL.md");
    }),
  );
});
