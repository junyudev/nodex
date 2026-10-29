import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { InboxAgentBinding, InboxChatAgent, InboxSettings } from "../../shared/inbox";
import type { Project, ProjectSession } from "../../shared/types";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { testLayer as configLayer } from "../app/MainConfig";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import type { CoreInboxDispatchContext, CoreInboxDispatchWork } from "../core-client/inbox-adapter";
import { fitPromptImages, type PromptImageBytes } from "../agent-backend/AgentImageFitting";
import { NativePromptImages } from "../agent-backend/NativePromptImages";
import { LibraryModule } from "../library-application/LibraryModule";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  InboxApplication,
  InboxApplicationError,
  type InboxSuggestionSettlement,
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
const claude = { instanceId: "claude:inbox" } as const;
const choice = (
  instanceId: string,
  model: string | null = null,
  reasoningEffort: string | null = null,
): InboxChatAgent => ({ instanceId, model, reasoningEffort, serviceTier: null });
const settings: InboxSettings = {
  suggestions: "automatic",
  suggestionAgent: claude,
  suggestionModel: null,
  instructions: "Prefer existing chats when relevant.",
  chatAgent: choice("codex"),
  suggestionsChooseModels: true,
  useModelGuide: true,
  showPageBesideNewChats: true,
};
const provider = (binding: InboxAgentBinding = { instanceId: "codex" }): Provider => ({
  instanceId: binding.instanceId,
  driver: binding.instanceId.startsWith("claude") ? "claudeAgent" : "codex",
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
  final_text: "Frozen complete message",
  image_sources: [],
  launch_id: "launch:stable",
  message_id: "message:stable",
  execution_selection: {
    model_selection: { instanceId: "codex", model: "confirmed-model" },
    interaction_mode: "plan",
  },
  target_execution_ref: null,
  failure_kind: null,
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
      scope: { kind: "library" },
      basis: { page_id: "page:one", content_hash: "a".repeat(64) },
      title_provisional: false,
    },
  ],
  scope: { kind: "library" },
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
const FITTED_JPEG = new Uint8Array([255, 216, 255]);

const delivery = (input: {
  runtime: Partial<Runtime>;
  inbox: Partial<InboxApplication["Service"]>;
  session: () => ProjectSession;
  project?: () => Project | null;
  /** Library Files by id; any other File is unavailable. */
  files?: Readonly<Record<string, { readonly mimeType: string; readonly bytes: Uint8Array }>>;
}) =>
  makeDelivery.pipe(
    // Fitting shrinks an oversized image to a small JPEG, as the Electron codec would.
    Effect.provideService(NativePromptImages, {
      fit: (images: readonly PromptImageBytes[]) =>
        Effect.promise(() =>
          fitPromptImages(images, async () => ({
            mediaType: "image/jpeg",
            bytes: FITTED_JPEG,
          })),
        ).pipe(
          Effect.map((fitted) =>
            fitted.map((image) => ({
              mediaType: image.mediaType,
              data: Buffer.from(image.bytes).toString("base64"),
            })),
          ),
        ),
    } as unknown as NativePromptImages["Service"]),
    Effect.provideService(LibraryModule, {
      readFileBlob: (_routing: unknown, request: { readonly fileId: string }) => {
        const file = input.files?.[request.fileId];
        return file
          ? Effect.succeed({ ...file, etag: request.fileId })
          : Effect.fail(new Error("File unavailable"));
      },
    } as unknown as LibraryModule["Service"]),
    Effect.provideService(AgentRuntimeApplication, {
      messageAdmission: () => Effect.succeed(null),
      ...input.runtime,
    } as Runtime),
    Effect.provideService(InboxApplication, {
      dispatchContext: () => Effect.succeed(context()),
      ...input.inbox,
    } as InboxApplication["Service"]),
    Effect.provideService(ProjectWorkspace, {
      getProjectSession: () => Effect.sync(input.session),
      getProject: () =>
        Effect.sync(
          input.project ??
            (() => ({ lifecycle: "active", primaryWorkspaceRoot: "/project" }) as Project),
        ),
    } as unknown as ProjectWorkspace["Service"]),
    Effect.provideService(ApplicationSettings, settingsService),
  );

it.effect("uses a warm model catalog without refreshing any Provider", () =>
  Effect.gen(function* () {
    const catalog = vi.fn(() => Effect.succeed([provider()]));
    const selection = yield* resolveInboxModel({ catalog }, choice("codex", null, "medium"));
    assert.deepEqual(selection, {
      instanceId: "codex",
      model: "default-model",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    assert.deepEqual(catalog.mock.calls, [[]]);
    // An effort the model does not offer falls back to the model's own.
    const withoutOptions = yield* resolveInboxModel(
      { catalog },
      choice("codex", "first-model", "medium"),
    );
    assert.deepEqual(withoutOptions, { instanceId: "codex", model: "first-model" });
  }),
);

it.effect("suggests on Codex's Sol model by default while chats keep the catalog default", () =>
  Effect.gen(function* () {
    const codex = provider();
    const sol = { ...codex.models[1]!, slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isDefault: false };
    const catalog = (models: Provider["models"]) => () => Effect.succeed([{ ...codex, models }]);
    const withSol = { catalog: catalog([...codex.models, sol]) };
    const suggestion = yield* resolveInboxModel(withSol, choice("codex"), "suggestion");
    assert.strictEqual(suggestion.model, "gpt-6.1-sol");
    const chat = yield* resolveInboxModel(withSol, choice("codex"));
    assert.strictEqual(chat.model, "default-model");
    const chosen = yield* resolveInboxModel(withSol, choice("codex", "first-model"), "suggestion");
    assert.strictEqual(chosen.model, "first-model");
    // A catalog without Sol keeps working on its own default.
    const withoutSol = yield* resolveInboxModel(
      { catalog: catalog(codex.models) },
      choice("codex"),
      "suggestion",
    );
    assert.strictEqual(withoutSol.model, "default-model");
  }),
);

it.effect("restricts only suggestion utilities while allowing other launch Providers", () =>
  Effect.gen(function* () {
    const opencode = { ...provider({ instanceId: "opencode:one" }), driver: "opencode" as const };
    const catalog = () => Effect.succeed([opencode]);
    const selected = yield* resolveInboxModel({ catalog }, choice(opencode.instanceId));
    assert.strictEqual(selected.instanceId, opencode.instanceId);
    const suggestion = yield* resolveInboxModel(
      { catalog },
      choice(opencode.instanceId),
      "suggestion",
    ).pipe(Effect.result);
    assert.strictEqual(suggestion._tag, "Failure");
    if (suggestion._tag === "Failure")
      assert.match(suggestion.failure.message, /cannot generate Inbox suggestions/);
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
      const pending = yield* resolveInboxModel({ catalog }, choice(claude.instanceId)).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      ready = true;
      yield* TestClock.adjust("200 millis");
      assert.deepEqual(yield* Fiber.join(pending), {
        instanceId: claude.instanceId,
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
    const pending = yield* resolveInboxModel({ catalog }, choice("codex")).pipe(
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

it.effect("reconciles durable acceptance after lost replies and archive without resubmission", () =>
  Effect.gen(function* () {
    let accepted = false;
    let pending = true;
    let loseComplete = true;
    let product = session();
    const calls: AgentRuntimeLaunch[] = [];
    const confirmed = work();
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
      messageAdmission: () =>
        Effect.succeed(
          accepted
            ? {
                status: "accepted",
                sequence: 1,
                error: null,
                runtimeId: "runtime:one",
                threadId: "thread:one",
                messageId: confirmed.message_id,
                commandId: "command:one",
              }
            : null,
        ),
      launch: (input) =>
        Effect.suspend(() => {
          calls.push(input);
          accepted = true;
          product = { ...session(true), archived: true };
          return Effect.fail(applicationError());
        }),
    };
    const input = {
      runtime,
      session: () => product,
      inbox: {
        outbox: () => Effect.succeed(pending ? [confirmed] : []),
        completeDispatch: complete,
        failDispatch: fail,
      },
    };
    yield* delivery(input).pipe(Effect.flatMap(({ drain }) => drain));
    assert.strictEqual(pending, true);
    yield* delivery(input).pipe(Effect.flatMap(({ drain }) => drain));
    assert.strictEqual(pending, false);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.message.text, confirmed.final_text);
    assert.strictEqual(calls[0]?.message.messageId, confirmed.message_id);
    assert.strictEqual(calls[0]?.launchId, confirmed.launch_id);
    assert.strictEqual(calls[0]?.acceptedAt, Date.parse(confirmed.confirmed_at));
    assert.deepEqual(calls[0]?.modelSelection, confirmed.execution_selection?.model_selection);
    assert.strictEqual(calls[0]?.interactionMode, "plan");
    assert.strictEqual(fail.mock.calls.length, 0);
  }),
);

it.effect("a dispatched chat receives the messages' Library images with their text", () =>
  Effect.gen(function* () {
    const calls: AgentRuntimeLaunch[] = [];
    const png = new Uint8Array([137, 80, 78, 71]);
    const confirmed = {
      ...work(),
      image_sources: [
        "nodex://files/shot",
        "nodex://files/vector",
        "nodex://files/trashed",
        "nodex://files/huge",
        "nodex://files/detail",
      ],
    };
    const { drain } = yield* delivery({
      session: () => session(),
      runtime: {
        launch: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return { threadId: "thread:one" } as never;
          }),
      },
      inbox: {
        outbox: () => Effect.succeed(calls.length === 0 ? [confirmed] : []),
        completeDispatch: () => Effect.void,
      },
      files: {
        shot: { mimeType: "image/png", bytes: png },
        vector: { mimeType: "image/svg+xml", bytes: png },
        huge: { mimeType: "image/png", bytes: new Uint8Array(6 * 1024 * 1024) },
        detail: { mimeType: "image/jpeg", bytes: png },
      },
    });
    yield* drain;
    // A kind of image an Agent cannot read, or one no longer in the Library, stays on its Page;
    // an oversized one is fitted rather than left out.
    assert.deepEqual(calls[0]?.message.images, [
      { source: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
      { source: `data:image/jpeg;base64,${Buffer.from(FITTED_JPEG).toString("base64")}` },
      { source: `data:image/jpeg;base64,${Buffer.from(png).toString("base64")}` },
    ]);
    assert.strictEqual(calls[0]?.message.text, confirmed.final_text);
  }),
);

it.effect("hands busy follow-ups to the Runtime queue and does not starve a ninth chat", () =>
  Effect.gen(function* () {
    const items = Array.from({ length: 9 }, (_, index) => ({
      ...work({ type: "send_to_chat", session_id: "session:one", prompt: "Follow up" }),
      proposal_id: `proposal:${index}`,
      message_id: `message:${index}`,
      thread_status: { status_type: "active" as const, active_flags: [] },
    }));
    const queueMessage = vi.fn<Runtime["queueMessage"]>(() => Effect.succeed({ sequence: 5 }));
    const complete = vi.fn(() => Effect.void);
    const { drain } = yield* delivery({
      session: () => session(true),
      runtime: { queueMessage },
      inbox: {
        outbox: () => Effect.succeed(items),
        completeDispatch: complete,
      },
    });
    yield* drain;
    assert.strictEqual(queueMessage.mock.calls.length, 9);
    assert.isTrue(queueMessage.mock.calls.every(([target]) => target.threadId === "thread:one"));
    assert.strictEqual(complete.mock.calls.length, 9);
  }),
);

it.effect("a durable rejection settles once and never submits again", () =>
  Effect.gen(function* () {
    const confirmed = work();
    const fail = vi.fn(() => Effect.void);
    const launch = vi.fn(() => Effect.die("must not submit"));
    const { drain } = yield* delivery({
      session: () => session(true),
      runtime: {
        launch,
        messageAdmission: () =>
          Effect.succeed({
            status: "rejected",
            sequence: 2,
            error: "Model unavailable",
            runtimeId: "runtime:one",
            threadId: "thread:one",
            messageId: confirmed.message_id,
            commandId: "command:one",
          }),
      },
      inbox: { outbox: () => Effect.succeed([confirmed]), failDispatch: fail },
    });
    yield* drain;
    assert.strictEqual(launch.mock.calls.length, 0);
    assert.deepEqual(fail.mock.calls[0], [confirmed, "Model unavailable", "rejected"]);
  }),
);

it.effect("settles a host admission refusal only after checking its original message receipt", () =>
  Effect.gen(function* () {
    for (const accepted of [false, true]) {
      const confirmed = work();
      let pending = true;
      let attempted = false;
      const fail = vi.fn(() =>
        Effect.sync(() => {
          pending = false;
        }),
      );
      const complete = vi.fn(() =>
        Effect.sync(() => {
          pending = false;
        }),
      );
      const launch = vi.fn(() => {
        attempted = true;
        return Effect.fail(
          new AgentRuntimeApplicationError({
            operation: "launch",
            message: "Session is already bound to another launch request",
            admissionRejected: true,
          }),
        );
      });
      const { drain } = yield* delivery({
        session: () => session(),
        runtime: {
          launch,
          messageAdmission: () =>
            Effect.succeed(
              attempted && accepted
                ? {
                    status: "accepted",
                    sequence: 2,
                    error: null,
                    runtimeId: "runtime:one",
                    threadId: "thread:original",
                    messageId: confirmed.message_id,
                    commandId: "command:one",
                  }
                : null,
            ),
        },
        inbox: {
          outbox: () => Effect.succeed(pending ? [confirmed] : []),
          failDispatch: fail,
          completeDispatch: complete,
        },
      });
      yield* drain;
      yield* drain;
      assert.strictEqual(launch.mock.calls.length, 1);
      assert.strictEqual(complete.mock.calls.length, accepted ? 1 : 0);
      assert.strictEqual(fail.mock.calls.length, accepted ? 0 : 1);
      if (!accepted)
        assert.deepEqual(fail.mock.calls[0], [
          confirmed,
          "Session is already bound to another launch request",
          "rejected",
        ]);
    }
  }),
);

it.effect("an unavailable local workspace fails visibly before runtime submission", () =>
  Effect.gen(function* () {
    const fail = vi.fn(() => Effect.void);
    const launch = vi.fn(() => Effect.die("must not submit"));
    const confirmed = work();
    const { drain } = yield* delivery({
      session: () => session(),
      project: () => null,
      runtime: { launch },
      inbox: { outbox: () => Effect.succeed([confirmed]), failDispatch: fail },
    });
    yield* drain;
    assert.strictEqual(launch.mock.calls.length, 0);
    assert.deepEqual(fail.mock.calls[0], [
      confirmed,
      "The Project has no available execution workspace",
      "unavailable",
    ]);
  }),
);

it.effect("reconciles legacy identities but never reconstructs historical text", () =>
  Effect.gen(function* () {
    const confirmed = { ...work(), final_text: null };
    const messageAdmission = vi.fn((_input: Parameters<Runtime["messageAdmission"]>[0]) =>
      Effect.succeed(null),
    );
    const fail = vi.fn(() => Effect.void);
    const launch = vi.fn(() => Effect.die("must not submit"));
    const { drain } = yield* delivery({
      session: () => session(true),
      runtime: { launch, messageAdmission },
      inbox: { outbox: () => Effect.succeed([confirmed]), failDispatch: fail },
    });
    yield* drain;
    assert.strictEqual(
      messageAdmission.mock.calls[0]?.[0].messageId,
      inboxDispatchIdentity(confirmed, "message"),
    );
    assert.strictEqual(
      messageAdmission.mock.calls[0]?.[0].launchId,
      inboxDispatchIdentity(confirmed, "launch"),
    );
    assert.strictEqual(launch.mock.calls.length, 0);
    assert.strictEqual(fail.mock.calls.length, 1);
  }),
);

it.effect("persists remote uncertainty before submitting and never automatically resends", () =>
  Effect.gen(function* () {
    const nativeSession = {
      ...session(),
      thread: {
        threadId: "thread:remote",
        executionHostId: "ssh:remote",
        backendBinding: { kind: "codex" },
        archived: false,
        statusType: "idle",
      } as ProjectSession["thread"],
    };
    let pending = true;
    const calls: string[] = [];
    const confirmed = {
      ...work({
        type: "send_to_chat",
        session_id: "session:one",
        prompt: "Follow up",
      }),
      thread_id: "thread:remote",
    };
    const start = vi.fn(() =>
      Effect.sync(() => {
        calls.push("start");
      }).pipe(Effect.andThen(Effect.fail(applicationError()))),
    );
    const complete = vi.fn(() => Effect.void);
    const { drain } = yield* delivery({
      session: () => nativeSession,
      runtime: {},
      inbox: {
        outbox: () => Effect.succeed(pending ? [confirmed] : []),
        completeDispatch: complete,
        beginDispatch: () =>
          Effect.sync(() => {
            pending = false;
            calls.push("persist-unknown");
          }),
      },
    }).pipe(
      Effect.provideService(CodexTurnCommands, {
        start,
      } as unknown as CodexTurnCommands["Service"]),
    );
    yield* drain;
    yield* drain;
    assert.deepEqual(calls, ["persist-unknown", "start"]);
    assert.strictEqual(start.mock.calls.length, 1);
    assert.strictEqual(complete.mock.calls.length, 0);
  }),
);

it.effect("a remote live acknowledgment remains unknown until durable evidence exists", () =>
  Effect.gen(function* () {
    const nativeSession = {
      ...session(),
      thread: {
        threadId: "thread:remote",
        executionHostId: "ssh:remote",
        backendBinding: { kind: "codex" },
        archived: false,
        statusType: "idle",
      } as ProjectSession["thread"],
    };
    const confirmed = {
      ...work({
        type: "send_to_chat",
        session_id: "session:one",
        prompt: "Follow up",
      }),
      thread_id: "thread:remote",
    };
    const complete = vi.fn(() => Effect.void);
    const fail = vi.fn(() => Effect.void);
    const start = vi.fn(() =>
      Effect.succeed({
        threadId: "thread:remote",
        turnId: "turn:one",
        status: "inProgress",
        itemIds: [],
      }),
    );
    const { drain } = yield* delivery({
      session: () => nativeSession,
      runtime: {},
      inbox: {
        outbox: () => Effect.succeed([confirmed]),
        beginDispatch: () => Effect.void,
        completeDispatch: complete,
        failDispatch: fail,
      },
    }).pipe(
      Effect.provideService(CodexTurnCommands, {
        start,
      } as unknown as CodexTurnCommands["Service"]),
    );
    yield* drain;
    assert.strictEqual(complete.mock.calls.length, 0);
    assert.deepEqual(fail.mock.calls[0], [
      { ...confirmed, revision: confirmed.revision + 1 },
      "Submitted to remote chat; open it to verify",
      "unknown",
    ]);
  }),
);

const suggestionOutput = (pageIds: string[], action = "send_to_chat") => ({
  request_id: "request:one",
  generation: 1,
  titles: [],
  suggestions: [
    {
      page_ids: pageIds,
      kind: action === "keep" ? "note" : "todo",
      action,
      project_id: null,
      session_id: action === "send_to_chat" ? "session:one" : null,
      prompt: action === "keep" ? null : "Continue with the evidence",
      chat_instance_id: null,
      chat_model: null,
      chat_effort: null,
      delegates: [],
      plan: null,
      summary: action === "keep" ? "Keep these thoughts for later" : "Continue the investigation",
      rationale: null,
    },
  ],
});

const suggestionHarness = (count = 1, action = "send_to_chat") =>
  Effect.gen(function* () {
    let pending = true;
    const routing = {
      ...context(),
      entries: Array.from({ length: count }, (_, index) => ({
        ...context().entries[0]!,
        page_id: `page:${index}`,
        basis: { page_id: `page:${index}`, content_hash: "a".repeat(64) },
      })),
    };
    const pageIds = routing.entries.map((entry) => entry.page_id);
    const generated = vi.fn<Runtime["generateStructured"]>(() =>
      Effect.succeed(suggestionOutput(pageIds, action)),
    );
    const settlements: InboxSuggestionSettlement[] = [];
    const inbox = {
      prepareSuggestions: () => Effect.void,
      suggestionRequests: () =>
        Effect.succeed(
          pending
            ? [
                {
                  request_id: "request:one",
                  generation: 1,
                  mode: count > 1 ? ("grouped" as const) : ("auto" as const),
                  page_ids: pageIds,
                  basis: routing.entries.map((entry) => entry.basis),
                  correction: null,
                  proposal_id: null,
                  expected_revision: null,
                  context: routing,
                },
              ]
            : [],
        ),
      settleSuggestion: (settlement: InboxSuggestionSettlement) =>
        Effect.sync(() => {
          settlements.push(settlement);
          pending = false;
        }),
    };
    const worker = yield* makeSuggestions.pipe(
      Effect.provideService(InboxApplication, inbox as unknown as InboxApplication["Service"]),
      Effect.provideService(ApplicationSettings, settingsService),
      Effect.provideService(AgentRuntimeApplication, {
        catalog: () => Effect.succeed([provider(), { ...provider(claude), displayName: "Claude" }]),
        generateStructured: generated,
      } as unknown as Runtime),
      Effect.provide(configLayer({ nodexHome: "/profiles/inbox" })),
    );
    return { ...worker, generated, settlements, pageIds };
  });

it.effect("settles a 16-message explicit group atomically with the actual resolved model", () =>
  Effect.gen(function* () {
    const { drain, generated, settlements, pageIds } = yield* suggestionHarness(16);
    yield* drain;
    assert.strictEqual(generated.mock.calls.length, 1);
    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0]?.suggestions.length, 1);
    assert.deepEqual(settlements[0]?.suggestions[0]?.page_ids, pageIds);
    // Provenance names the Agent and model as the user knows them.
    assert.strictEqual(settlements[0]?.produced_by, "Claude · Default");
    const request = generated.mock.calls[0]![0];
    assert.deepEqual(request.modelSelection, {
      instanceId: claude.instanceId,
      model: "default-model",
      // Suggestions also choose models and plan delegation, so Claude suggests at medium effort.
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    // The suggestion is offered the live Agents and the Inbox's own chat Agent to choose among.
    const data = JSON.parse(request.prompt.split("JSON data:\n")[1]!);
    assert.deepEqual(
      data.agents.map((agent: { instance_id: string }) => agent.instance_id),
      ["codex", claude.instanceId],
    );
    assert.strictEqual(data.default_chat_agent.instance_id, "codex");
    assert.strictEqual(request.maxOutputBytes, INBOX_SUGGESTION_MAX_OUTPUT_BYTES);
    assert.strictEqual(request.timeoutMs, INBOX_SUGGESTION_TIMEOUT_MS);
    assert.include(request.prompt, "Captured evidence");
  }),
);

it.effect("a failed suggestion keeps the runtime's own reason under the generic failure", () =>
  Effect.gen(function* () {
    const { drain, generated, settlements } = yield* suggestionHarness(1);
    generated.mockImplementation(() =>
      Effect.fail(
        new AgentRuntimeApplicationError({
          operation: "structured-generation",
          message: "Agent operation could not be completed",
          cause: new Error("Agent Runtime request timed out"),
        }),
      ),
    );
    yield* drain;
    assert.strictEqual(settlements[0]?.error, "The suggestion agent timed out");
  }),
);

it.effect("settles a confirmable Keep suggestion once instead of repeating it on every poll", () =>
  Effect.gen(function* () {
    const { drain, generated, settlements } = yield* suggestionHarness(1, "keep");
    yield* drain;
    yield* drain;
    assert.strictEqual(generated.mock.calls.length, 1);
    assert.deepEqual(settlements[0]?.suggestions[0]?.action, { type: "keep" });
    assert.strictEqual(settlements[0]?.suggestions[0]?.summary, "Keep these thoughts for later");
    assert.strictEqual(settlements[0]?.error, null);
  }),
);

it.effect(
  "records an abstaining model output as a failed request, never a successful decision",
  () =>
    Effect.gen(function* () {
      const { drain, generated, settlements } = yield* suggestionHarness(1, "none");
      yield* drain;
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 1);
      assert.strictEqual(settlements.length, 1);
      assert.deepEqual(settlements[0]?.suggestions, []);
      assert.isNotNull(settlements[0]?.error);
      assert.isNull(settlements[0]?.produced_by);
    }),
);
