import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import type { AgentRuntimeInspection, AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import type { InboxAgentBinding, InboxSettings } from "../../shared/inbox";
import type { ProjectSession } from "../../shared/types";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { testLayer as configLayer } from "../app/MainConfig";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import type { CoreInboxDispatchContext, CoreInboxDispatchWork } from "../core-client/inbox-adapter";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  InboxApplication,
  InboxApplicationError,
  type InboxSuggestionProposal,
} from "./InboxApplication";
import { inboxDispatchIdentity, make as makeDelivery } from "./InboxDispatchRuntime";
import { make as makeSuggestions } from "./InboxDispatcher";
import { resolveInboxModel } from "./InboxRuntimeSelection";
import {
  INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
  INBOX_SUGGESTION_TIMEOUT_MS,
} from "./inbox-suggestions";

type Runtime = AgentRuntimeApplication["Service"];
type Provider = Effect.Success<ReturnType<Runtime["catalog"]>>[number];
const claude = { kind: "claude", instanceConfigId: "claude:inbox" } as const;
const settings: InboxSettings = {
  suggestionsEnabled: true,
  suggestionAgent: claude,
  suggestionModel: null,
  instructions: "Prefer existing chats when relevant.",
  chatAgent: { kind: "codex" },
};
const provider = (binding: InboxAgentBinding = { kind: "codex" }): Provider => ({
  instanceId: agentRuntimeProviderId(binding)!,
  driver: binding.kind === "claude" ? "claudeAgent" : "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00.000Z",
  models: [
    { slug: "first-model", name: "First", isCustom: false, capabilities: {} },
    {
      slug: "default-model",
      name: "Default",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
});
const work = (
  action: CoreInboxDispatchWork["action"] = {
    type: "new_chat",
    project_id: "project:one",
    prompt: "Investigate this issue",
  },
): CoreInboxDispatchWork => ({
  proposal_id: "proposal:one",
  revision: 2,
  action,
  session_id: "session:one",
  project_id: "project:one",
  thread_id: null,
  page_ids: ["page:one"],
  page_keys: ["IN-1"],
  attempt: 1,
  confirmed_at: "2026-01-01T00:00:00.000Z",
  thread_status: null,
  thread_backend_kind: null,
});
const session = (bound = false): ProjectSession => ({
  id: "session:one",
  projectId: "project:one",
  noThreadFallbackTitle: "Investigation",
  displayTitle: "Investigation",
  order: 1,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  thread: null,
  executionRef: bound ? { runtimeId: "runtime:one", threadId: "thread:one" } : null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const inspection = (activeRunId: string | null = null): AgentRuntimeInspection =>
  ({
    sessionId: "session:one",
    projectId: "project:one",
    runtimeId: "runtime:one",
    rootThreadId: "thread:one",
    threadId: "thread:one",
    thread: {
      id: "thread:one",
      title: "Investigation",
      activeRunId,
      modelSelection: { instanceId: agentRuntimeProviderId(claude)!, model: "original-model" },
      interactionMode: "plan",
    },
  }) as AgentRuntimeInspection;
const context = (): CoreInboxDispatchContext => ({
  entries: [
    {
      page_id: "page:one",
      page_key: "IN-1",
      title: "Investigate",
      body: "Captured evidence",
      source: { kind: "user" },
      kind: null,
      submitted_at: "2026-10-15T00:00:00.000Z",
      basis: { page_id: "page:one", generation: 1, head_seq: 3 },
      title_provisional: false,
    },
  ],
  projects: [{ project_id: "project:one", name: "Project", description: "" }],
  sessions: [
    {
      session_id: "session:one",
      project_id: "project:one",
      title: "Investigation",
      preview: "",
      status: null,
      recency_at: 1,
    },
  ],
  open_proposals: [],
});
const applicationError = () =>
  new AgentRuntimeApplicationError({ operation: "launch", message: "Reply lost" });
const inboxError = () =>
  new InboxApplicationError({ operation: "complete", message: "Reply lost", cause: null });
const settingsService = ApplicationSettings.of({
  snapshot: () => Effect.succeed({ inbox: settings }),
} as unknown as ApplicationSettings["Service"]);
const delivery = (input: {
  runtime: Partial<Runtime>;
  inbox: Partial<InboxApplication["Service"]>;
  session: () => ProjectSession;
}) =>
  makeDelivery.pipe(
    Effect.provideService(AgentRuntimeApplication, input.runtime as Runtime),
    Effect.provideService(InboxApplication, {
      dispatchContext: () => Effect.succeed(context()),
      ...input.inbox,
    } as InboxApplication["Service"]),
    Effect.provideService(ProjectWorkspace, {
      getProjectSession: () => Effect.sync(input.session),
    } as unknown as ProjectWorkspace["Service"]),
    Effect.provideService(ApplicationSettings, settingsService),
  );

it.effect("uses a warm model catalog without refreshing any Provider", () =>
  Effect.gen(function* () {
    const catalog = vi.fn(() => Effect.succeed([provider()]));
    const selection = yield* resolveInboxModel({ catalog }, { kind: "codex" }, null, "medium");
    assert.deepEqual(selection, {
      instanceId: "codex",
      model: "default-model",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    assert.deepEqual(catalog.mock.calls, [[]]);
    const withoutOptions = yield* resolveInboxModel(
      { catalog },
      { kind: "codex" },
      "first-model",
      "medium",
    );
    assert.deepEqual(withoutOptions, { instanceId: "codex", model: "first-model" });
  }),
);

it.effect(
  "refreshes a cold catalog once and waits for the configured instance's default model",
  () =>
    Effect.gen(function* () {
      let ready = false;
      const catalog: Runtime["catalog"] = vi.fn(() =>
        Effect.sync(() => [
          provider(),
          ready
            ? provider(claude)
            : { ...provider(claude), installed: false, status: "warning" as const, models: [] },
        ]),
      );
      const pending = yield* resolveInboxModel({ catalog }, claude).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      ready = true;
      yield* TestClock.adjust("200 millis");
      assert.deepEqual(yield* Fiber.join(pending), {
        instanceId: agentRuntimeProviderId(claude)!,
        model: "default-model",
      });
      const calls = vi.mocked(catalog).mock.calls;
      assert.strictEqual(calls.filter(([input]) => input?.refresh === true).length, 1);
      assert.isAtLeast(calls.length, 3);
    }),
);

it.effect("ends a cold catalog wait at its bounded deadline", () =>
  Effect.gen(function* () {
    const catalog: Runtime["catalog"] = vi.fn(() =>
      Effect.succeed([{ ...provider(), models: [] }]),
    );
    const pending = yield* resolveInboxModel({ catalog }, { kind: "codex" }).pipe(
      Effect.result,
      Effect.forkChild,
    );
    yield* TestClock.adjust("16 seconds");
    const result = yield* Fiber.join(pending);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.match(result.failure.message, /did not become ready/);
    assert.isAtMost(vi.mocked(catalog).mock.calls.length, 78);
  }),
);

it.effect(
  "replays a bound launch and its message after uncertain execution and completion replies",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-15T00:00:00.000Z"));
      let current = work();
      let product = session();
      let pending = true;
      let loseLaunch = true;
      let loseComplete = true;
      const accepted = new Set<string>();
      const calls: AgentRuntimeLaunch[] = [];
      const complete = vi.fn(() =>
        Effect.suspend(() => {
          if (loseComplete) {
            loseComplete = false;
            return Effect.fail(inboxError());
          }
          pending = false;
          return Effect.void;
        }),
      );
      const fail = vi.fn(() => Effect.void);
      const runtime: Partial<Runtime> = {
        catalog: () => Effect.succeed([provider()]),
        inspect: () => Effect.succeed(inspection("run:already-accepted")),
        launch: (input) =>
          Effect.suspend(() => {
            calls.push(input);
            accepted.add(input.message.messageId);
            product = session(true);
            current = { ...current, thread_id: "thread:one" };
            if (loseLaunch) {
              loseLaunch = false;
              return Effect.fail(applicationError());
            }
            return Effect.succeed({
              sessionId: product.id,
              projectId: product.projectId,
              threadId: "thread:one",
            });
          }),
      };
      const input = {
        runtime,
        session: () => product,
        inbox: {
          outbox: () => Effect.sync(() => (pending ? [current] : [])),
          completeDispatch: complete,
          failDispatch: fail,
        },
      };
      yield* delivery(input).pipe(Effect.flatMap(({ drain }) => drain));
      assert.strictEqual(complete.mock.calls.length, 0);
      assert.strictEqual(fail.mock.calls.length, 0);
      yield* TestClock.adjust("1 day");
      // A new worker models process restart: the durable outbox and binding are the only proof.
      yield* delivery(input).pipe(Effect.flatMap(({ drain }) => drain));
      assert.strictEqual(pending, true);
      yield* delivery(input).pipe(Effect.flatMap(({ drain }) => drain));
      assert.strictEqual(pending, false);
      assert.strictEqual(accepted.size, 1);
      assert.strictEqual(calls.length, 3);
      assert.strictEqual(new Set(calls.map((call) => call.launchId)).size, 1);
      assert.strictEqual(calls[0]?.message.messageId, inboxDispatchIdentity(current, "message"));
      assert.isAbove(calls[0]!.acceptedAt, Date.parse(current.confirmed_at));
      assert.isAbove(calls[1]!.acceptedAt, calls[0]!.acceptedAt);
      assert.deepEqual(calls[1]?.modelSelection, inspection().thread.modelSelection);
      assert.strictEqual(calls[1]?.interactionMode, "plan");
      assert.strictEqual(fail.mock.calls.length, 0);
    }),
);

it.effect(
  "waits for actual Session idleness and retries one queued follow-up after a lost reply",
  () =>
    Effect.gen(function* () {
      let busy = true;
      let replyLost = true;
      let pending = true;
      const accepted = new Set<string>();
      const message = vi.fn((input: Parameters<Runtime["queueMessage"]>[0]) =>
        Effect.suspend(() => {
          accepted.add(input.message.messageId);
          if (replyLost) {
            replyLost = false;
            return Effect.fail(applicationError());
          }
          return Effect.succeed({ sequence: 5 });
        }),
      );
      const inspect = vi.fn((_input: Parameters<Runtime["inspect"]>[0]) =>
        Effect.sync(() => inspection(busy ? "run:busy" : null)),
      );
      const complete = vi.fn(() =>
        Effect.sync(() => {
          pending = false;
        }),
      );
      const fail = vi.fn(() => Effect.void);
      const confirmed = {
        ...work({ type: "send_to_chat", session_id: "session:one", prompt: "Follow up" }),
        thread_id: "stale-native-thread",
        thread_status: { status_type: "active" as const, active_flags: [] },
      };
      const { drain } = yield* delivery({
        session: () => session(true),
        runtime: { inspect, queueMessage: message },
        inbox: {
          outbox: () => Effect.sync(() => (pending ? [confirmed] : [])),
          completeDispatch: complete,
          failDispatch: fail,
        },
      });
      yield* drain;
      assert.strictEqual(message.mock.calls.length, 0);
      assert.strictEqual(complete.mock.calls.length, 0);
      busy = false;
      yield* drain;
      assert.strictEqual(complete.mock.calls.length, 0);
      yield* drain;
      assert.strictEqual(pending, false);
      assert.deepEqual(inspect.mock.calls, [
        [{ sessionId: "session:one" }],
        [{ sessionId: "session:one" }],
        [{ sessionId: "session:one" }],
      ]);
      assert.strictEqual(message.mock.calls.length, 2);
      assert.deepEqual(message.mock.calls[0]?.[0], {
        sessionId: "session:one",
        message: {
          messageId: inboxDispatchIdentity(confirmed, "message"),
          text: message.mock.calls[1]?.[0].message.text,
        },
      });
      assert.strictEqual(accepted.size, 1);
      assert.strictEqual(fail.mock.calls.length, 0);
    }),
);

it.effect("keeps the native writer confined to explicitly remote Codex Sessions", () =>
  Effect.gen(function* () {
    const nativeSession = session();
    nativeSession.thread = {
      threadId: "thread:remote",
      executionHostId: "ssh:remote",
      backendBinding: { kind: "codex" },
      archived: false,
      statusType: "idle",
    } as ProjectSession["thread"];
    const start = vi.fn(() =>
      Effect.succeed({
        threadId: "thread:remote",
        turnId: "turn:one",
        status: "inProgress" as const,
        itemIds: [],
      }),
    );
    const complete = vi.fn(() => Effect.void);
    const fail = vi.fn(() => Effect.void);
    const input = {
      session: () => nativeSession,
      runtime: {},
      inbox: {
        outbox: () =>
          Effect.succeed([
            work({ type: "send_to_chat", session_id: "session:one", prompt: "Follow up" }),
          ]),
        completeDispatch: complete,
        failDispatch: fail,
      },
    };
    const { drain } = yield* delivery(input).pipe(
      Effect.provideService(CodexTurnCommands, {
        start,
      } as unknown as CodexTurnCommands["Service"]),
    );
    yield* drain;
    assert.strictEqual(start.mock.calls.length, 1);
    assert.strictEqual(complete.mock.calls.length, 1);
    nativeSession.thread!.executionHostId = "local";
    yield* drain;
    assert.strictEqual(start.mock.calls.length, 1);
    assert.strictEqual(fail.mock.calls.length, 1);
  }),
);

it.effect(
  "generates structured suggestions for the selected Provider and validates product Session targets",
  () =>
    Effect.gen(function* () {
      let pending = true;
      const proposed: InboxSuggestionProposal[] = [];
      const generated = vi.fn((_input: Parameters<Runtime["generateStructured"]>[0]) =>
        Effect.succeed({
          titles: [],
          suggestions: [
            {
              page_ids: ["page:one"],
              kind: "todo",
              action: "send_to_chat",
              project_id: null,
              session_id: "session:one",
              prompt: "Continue with the evidence",
              summary: "Continue the investigation",
              rationale: "The existing investigation is relevant",
            },
          ],
        }),
      );
      const failures = vi.fn(() => Effect.void);
      const inbox = {
        pendingSuggestions: () => Effect.succeed(pending ? context().entries : []),
        dispatchContext: () => Effect.succeed(context()),
        recordSuggestionFailure: failures,
        propose: (proposal: InboxSuggestionProposal) =>
          Effect.sync(() => {
            proposed.push(proposal);
            pending = false;
          }),
      };
      const { drain } = yield* makeSuggestions.pipe(
        Effect.provideService(InboxApplication, inbox as unknown as InboxApplication["Service"]),
        Effect.provideService(ApplicationSettings, settingsService),
        Effect.provideService(AgentRuntimeApplication, {
          catalog: () => Effect.succeed([provider(), provider(claude)]),
          generateStructured: generated,
        } as unknown as Runtime),
        Effect.provide(configLayer({ nodexHome: "/profiles/inbox" })),
      );
      yield* drain;
      assert.strictEqual(proposed.length, 1);
      assert.deepEqual(proposed[0]?.action, {
        type: "send_to_chat",
        sessionId: "session:one",
        prompt: "Continue with the evidence",
      });
      assert.strictEqual(failures.mock.calls.length, 0);
      const request = vi.mocked(generated).mock.calls[0]?.[0] as unknown as Parameters<
        Runtime["generateStructured"]
      >[0];
      assert.deepEqual(request.modelSelection, {
        instanceId: agentRuntimeProviderId(claude)!,
        model: "default-model",
        options: [{ id: "reasoningEffort", value: "low" }],
      });
      assert.strictEqual(request.cwd, "/profiles/inbox");
      assert.strictEqual(request.maxOutputBytes, INBOX_SUGGESTION_MAX_OUTPUT_BYTES);
      assert.strictEqual(request.timeoutMs, INBOX_SUGGESTION_TIMEOUT_MS);
      assert.include(request.prompt, "Captured evidence");
    }),
);
