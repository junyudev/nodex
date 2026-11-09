import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests persistence through the real settings document with a disposable directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Names the disposable settings document.
import { join } from "node:path";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import type { ReadbackEvent } from "../../shared/readback";
import { UserPresence } from "../../host/UserPresence";
import type { AgentRuntimeActivityTransition } from "../agent-runtime/AgentRuntimeSessionActivity";
import {
  CodexApplicationEventHub,
  type CodexApplicationEvent,
} from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings, make as makeSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { ReadbackRuntime, live } from "./ReadbackRuntime";
import type { RendererClientEvent } from "../codex/renderer-client-runtime-contracts";

const activity = (
  patch: Partial<AgentRuntimeSessionActivity> = {},
): AgentRuntimeSessionActivity => ({
  sessionId: "chat",
  threadId: "root",
  status: "running",
  activeRunId: "run",
  pendingRequestCount: 0,
  backgroundTasks: [],
  providerInstanceId: "codex",
  model: "model",
  updatedAt: "2026-11-09T00:00:00Z",
  readback: {
    runId: "run",
    itemId: "item",
    text: "I'll investigate **this**.",
    startedByPerson: true,
  },
  ...patch,
});
const transition = (
  patch: Partial<AgentRuntimeActivityTransition> & { replay?: boolean } = {},
): AgentRuntimeActivityTransition => ({
  connection: {} as AgentRuntimeActivityTransition["connection"],
  sessionId: "chat",
  rootThreadId: "root",
  before: activity({ readback: null }),
  after: activity(),
  endedRun: null,
  ...patch,
});

const setup = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-readback-"))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
  const settings = yield* makeSettings({
    environment: {},
    hostHomeDirectory: directory,
    settingsPath: join(directory, "config.toml"),
  });
  const events = yield* PubSub.unbounded<CodexApplicationEvent>();
  const clients = yield* PubSub.unbounded<RendererClientEvent>();
  const delivered: { clientId: string; event: ReadbackEvent & { spaceId: string } }[] = [];
  const state = {
    seen: false,
    archived: false,
    deleted: false,
    foreground: false,
    locked: false,
    source: null as string | null,
    sourceAvailable: true,
    presented: "presented-window" as string | null,
    fallback: "last-window" as string | null,
  };
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.buildWithScope(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CoreAuthority, {
            identity: { libraryId: "personal" },
          } as CoreAuthority["Service"]),
          Layer.succeed(ApplicationSettings, settings),
          Layer.succeed(UserPresence, { isSeen: () => state.seen } as never),
          Layer.succeed(CodexApplicationEventHub, { events: Stream.fromPubSub(events) } as never),
          Layer.succeed(CodexRendererPresentationRegistry, {
            resolvePresentedSurfaceClient: () => state.presented,
            hasForegroundClient: () => !state.locked && state.foreground,
          } as never),
          Layer.succeed(WindowRuntime, {
            getLastFocused: () => (state.fallback ? { webContents: { id: 1 } } : null),
            get: () => ({
              isDestroyed: () => false,
              isFocused: () => state.foreground,
              isMinimized: () => false,
            }),
          } as never),
          Layer.succeed(RendererClientRuntime, {
            getClientIdForWebContentsId: () => state.fallback,
            getWebContentsIdForClientId: () => 1,
            events: Stream.fromPubSub(clients),
            sendToClient: (
              clientId: string,
              _channel: string,
              event: ReadbackEvent & { spaceId: string },
            ) => {
              delivered.push({ clientId, event });
              return true;
            },
          } as never),
          Layer.succeed(ProjectWorkspace, {
            getProjectSession: (id: string) =>
              Effect.succeed(
                id === state.source
                  ? state.sourceAvailable
                    ? { archived: false, executionRef: { threadId: "source-root" } }
                    : null
                  : state.deleted
                    ? null
                    : { displayTitle: "Chat title", archived: state.archived, unread: false },
              ),
          } as never),
          Layer.succeed(CoreModules, {
            workspace: {
              read: () =>
                Effect.succeed({
                  value: {
                    kind: "agent_runtime_session_binding",
                    binding: { side_chat_source_session_id: state.source },
                  },
                }),
            },
          } as never),
        ),
      ),
    ),
    scope,
  );
  const runtime = Context.get(context, ReadbackRuntime);
  const settle = Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow));
  return {
    runtime,
    state,
    delivered,
    settings,
    scope,
    settle,
    publish: (event: CodexApplicationEvent) =>
      PubSub.publish(events, event).pipe(Effect.andThen(settle)),
    dispose: PubSub.publish(clients, {
      kind: "disposed",
      clientId: "presented-window",
      webContentsId: 1,
      reason: "destroyed",
    }).pipe(Effect.andThen(settle)),
  };
});

it.effect("admits the person's unseen opening once, unedited, into exactly one window", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.runtime.observe(transition());
    yield* f.runtime.observe(transition({ before: activity() }));
    assert.strictEqual(f.delivered.length, 1);
    assert.strictEqual(f.delivered[0]?.clientId, "presented-window");
    assert.deepEqual(f.delivered[0]?.event, {
      type: "show",
      spaceId: "personal",
      readback: {
        id: "readback:chat:run",
        sessionId: "chat",
        threadId: "root",
        runId: "run",
        itemId: "item",
        text: "I'll investigate **this**.",
        title: "Chat title",
        createdAt: 0,
        navigation: {
          hostId: "local",
          conversationId: "root",
          navigationPath: "session:chat/thread:root",
          activateTabId: null,
        },
      },
    });
  }),
);

it.effect("suppresses automatic, seen, disabled, archived, absent and stale-Run openings", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.runtime.observe(
      transition({
        after: activity({ readback: { ...activity().readback!, startedByPerson: false } }),
      }),
    );
    f.state.seen = true;
    yield* f.runtime.observe(transition());
    f.state.seen = false;
    f.state.archived = true;
    yield* f.runtime.observe(transition());
    f.state.archived = false;
    f.state.deleted = true;
    yield* f.runtime.observe(transition());
    f.state.deleted = false;
    yield* f.runtime.observe(transition({ after: activity({ activeRunId: "newer" }) }));
    yield* f.settings.update({
      type: "update-thread-notifications",
      input: { turnMode: "always", questionsEnabled: true, readbackEnabled: false },
    });
    yield* f.runtime.observe(transition());
    assert.deepEqual(f.delivered, []);
  }),
);

it.effect("falls back to the last live window, or drops when no window is available", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    f.state.presented = null;
    yield* f.runtime.observe(transition());
    assert.strictEqual(f.delivered[0]?.clientId, "last-window");
    f.state.fallback = null;
    yield* f.runtime.observe(transition());
    assert.strictEqual(f.delivered.length, 1);
  }),
);

it.effect("opens a side chat's tab in its source, and skips an unresolved source", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    f.state.source = "source-chat";
    yield* f.runtime.observe(transition());
    const event = f.delivered[0]?.event;
    assert.strictEqual(event?.type, "show");
    if (event?.type !== "show") return;
    assert.deepEqual(event.readback.navigation, {
      hostId: "local",
      conversationId: "root",
      navigationPath: "session:source-chat/thread:source-root",
      activateTabId: "sidechat-session:chat",
    });
    f.state.sourceAvailable = false;
    yield* f.runtime.observe(transition());
    assert.strictEqual(f.delivered.length, 1);
  }),
);

it.effect("does not replay recovered snapshot openings or retained openings after reconnect", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.runtime.observe(transition({ replay: true }));
    yield* f.runtime.observe(
      transition({ before: activity(), after: activity({ pendingRequestCount: 1 }) }),
    );
    assert.deepEqual(f.delivered, []);
    yield* Scope.close(f.scope, Exit.void);
    const restarted = yield* setup;
    yield* restarted.runtime.observe(transition({ before: activity(), after: activity() }));
    assert.deepEqual(restarted.delivered, []);
  }),
);

it.effect("withdraws on shared seen signals, including phone views, only once", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.runtime.observe(transition());
    yield* f.publish({ kind: "conversationSeen", value: "other" });
    assert.strictEqual(f.delivered.length, 1);
    yield* f.publish({ kind: "conversationSeen", value: "root", memberId: "phone-member" });
    yield* f.publish({ kind: "conversationSeen", value: "root" });
    assert.deepEqual(f.delivered.slice(1), [
      {
        clientId: "presented-window",
        event: { type: "withdraw", id: "readback:chat:run", reason: "seen", spaceId: "personal" },
      },
    ]);
  }),
);

it.effect("withdraws exact ended Runs only while their holding window is backgrounded", () =>
  Effect.gen(function* () {
    const ended = transition({
      before: activity(),
      after: null,
      endedRun: { runId: "run", status: "completed" },
    });
    const background = yield* setup;
    yield* background.runtime.observe(transition());
    yield* background.runtime.observe({
      ...ended,
      endedRun: { runId: "different", status: "completed" },
    });
    assert.strictEqual(background.delivered.length, 1);
    yield* background.runtime.observe(ended);
    assert.deepEqual(background.delivered[1]?.event, {
      type: "withdraw",
      id: "readback:chat:run",
      reason: "ended",
      spaceId: "personal",
    });
    const foreground = yield* setup;
    foreground.state.foreground = true;
    yield* foreground.runtime.observe(transition());
    yield* foreground.runtime.observe(ended);
    assert.strictEqual(foreground.delivered.length, 1);
    const locked = yield* setup;
    locked.state.foreground = true;
    locked.state.locked = true;
    yield* locked.runtime.observe(transition());
    yield* locked.runtime.observe(ended);
    assert.strictEqual(locked.delivered[1]?.event.type, "withdraw");
  }),
);

it.effect("withdraws all cards on disable and forgets disposed renderer records", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.runtime.observe(transition());
    yield* f.runtime.observe(
      transition({
        sessionId: "chat2",
        rootThreadId: "root2",
        after: activity({ sessionId: "chat2", threadId: "root2" }),
      }),
    );
    yield* f.settings.update({
      type: "update-thread-notifications",
      input: { turnMode: "off", questionsEnabled: false, readbackEnabled: false },
    });
    yield* f.settle;
    assert.deepEqual(f.delivered[2]?.event, {
      type: "withdraw",
      id: "readback:chat:run",
      reason: "disabled",
      spaceId: "personal",
    });
    assert.deepEqual(f.delivered[3]?.event, {
      type: "withdraw",
      id: "readback:chat2:run",
      reason: "disabled",
      spaceId: "personal",
    });
    yield* f.settings.update({
      type: "update-thread-notifications",
      input: { turnMode: "off", questionsEnabled: false, readbackEnabled: true },
    });
    yield* f.runtime.observe(transition());
    yield* f.dispose;
    yield* f.publish({ kind: "conversationSeen", value: "root" });
    assert.strictEqual(f.delivered.length, 5);
  }),
);

it.effect("withdraws archived or deleted Sessions and replaces bookkeeping by Session", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.runtime.observe(transition());
    yield* f.runtime.observe(
      transition({
        after: activity({
          activeRunId: "next",
          readback: { ...activity().readback!, runId: "next" },
        }),
      }),
    );
    f.state.archived = true;
    yield* f.publish({ kind: "sessionOrganizationChanged", value: null });
    assert.deepEqual(f.delivered[2]?.event, {
      type: "withdraw",
      id: "readback:chat:next",
      reason: "removed",
      spaceId: "personal",
    });
    f.state.archived = false;
    yield* f.runtime.observe(transition());
    f.state.deleted = true;
    yield* f.publish({ kind: "sessionOrganizationChanged", value: null });
    assert.strictEqual(f.delivered.length, 5);
  }),
);
