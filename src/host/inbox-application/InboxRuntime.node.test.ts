import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import type { LibraryModuleReadRequest } from "../../shared/library-module";
import type { ReadFileBytesInput } from "../../shared/library-files";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { InboxAgentBinding, InboxAgentChoice, InboxSettings } from "../../shared/inbox";
import type { ProjectSession } from "../../shared/types";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../../main/agent-runtime/AgentRuntimeApplication";
import { NativeConversationDelivery } from "../NativeConversationDelivery";
import type {
  CoreInboxDispatchContext,
  CoreInboxDispatchWork,
} from "../../main/core-client/inbox-adapter";
import { fitPromptImages, type PromptImageBytes } from "../../main/agent-backend/AgentImageFitting";
import { NativePromptImages } from "../../main/agent-backend/NativePromptImages";
import { LibraryModule } from "../../main/library-application/LibraryModule";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { InboxApplication, InboxApplicationError } from "./InboxApplication";
import {
  inboxDispatchFingerprint,
  inboxDispatchIdentity,
  make as makeDelivery,
} from "./InboxDispatchRuntime";
import { resolveInboxModel } from "./InboxRuntimeSelection";

type Runtime = AgentRuntimeApplication["Service"];
type Provider = Effect.Success<ReturnType<Runtime["catalog"]>>[number];
const claude = { instanceId: "claude:inbox" } as const;
const choice = (
  instanceId: string,
  model: string | null = null,
  reasoningEffort: string | null = null,
): InboxAgentChoice => ({ instanceId, model, reasoningEffort, serviceTier: null });
const settings: InboxSettings = {
  suggestions: "automatic",
  dispatchMode: "suggest",
  suggestionAgent: choice(claude.instanceId),
  suggestionConcurrency: 5,
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
  images: [],
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
  activityAt: 1,
  managed: false,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  remindAt: null,
  canManage: true,
  canStop: true,
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
      body: "Captured evidence",
      images: [],
      source: { kind: "user" },
      kind: null,
      submitted_at: "2026-10-15T00:00:00.000Z",
      scope: { kind: "library" },
      basis: { page_id: "page:one", content_hash: "a".repeat(64) },
      title_provisional: false,
    },
  ],
  scope: { kind: "library" },
  projects: [{ project_id: "project:one", name: "Project", description: "", sources: [] }],
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

type ImageFiles = Readonly<
  Record<string, { readonly mimeType: string; readonly bytes: Uint8Array }>
>;
const imageLayer = (files: ImageFiles = {}, fit?: NativePromptImages["Service"]["fit"]) =>
  Layer.merge(
    Layer.succeed(NativePromptImages, {
      validate: () => Effect.void,
      // Fitting shrinks an oversized image to a small JPEG, as the Electron codec would.
      fit:
        fit ??
        ((images: readonly PromptImageBytes[]) =>
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
          )),
    } as unknown as NativePromptImages["Service"]),
    Layer.succeed(LibraryModule, {
      read: (_routing: unknown, request: LibraryModuleReadRequest) => {
        if (request.read.mode !== "file_versions") return Effect.die("Expected File versions");
        const file = files[request.read.file_id];
        return Effect.succeed({
          ok: true,
          value: {
            profileId: "profile",
            libraryId: "library",
            storeEpoch: "epoch",
            commitSeq: 1,
            value: {
              kind: "file_versions",
              value: {
                items: file
                  ? [
                      {
                        version: 1,
                        blob_etag: createHash("sha256").update(file.bytes).digest("hex"),
                      },
                    ]
                  : [],
                has_more: false,
                next_cursor: null,
              },
            },
          },
        });
      },
      readFileBlob: (_routing: unknown, request: ReadFileBytesInput) => {
        if (request.version !== 1) return Effect.die("Expected an immutable File version");
        const file = files[request.fileId];
        return file
          ? Effect.succeed({ ...file, etag: request.fileId })
          : Effect.fail(new Error("File unavailable"));
      },
    } as unknown as LibraryModule["Service"]),
  );

const delivery = (input: {
  runtime: Partial<Runtime>;
  inbox: Partial<InboxApplication["Service"]>;
  session: () => ProjectSession;
  /** Library Files by id; any other File is unavailable. */
  files?: ImageFiles;
}) =>
  makeDelivery.pipe(
    Effect.provide(imageLayer(input.files)),
    Effect.provideService(AgentRuntimeApplication, {
      messageAdmission: () => Effect.succeed(null),
      executionWorkspace: () =>
        Effect.succeed({ available: true, workspaceRoot: "/project", sourceRoots: ["/project"] }),
      ...input.runtime,
    } as Runtime),
    Effect.provideService(InboxApplication, {
      executionHeld: () => Effect.succeed(false),
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

it.effect(
  "waits for an Agent whose first status check timed out while its catalog loaded, rather than calling it unavailable",
  () =>
    Effect.gen(function* () {
      // A fresh host's Codex check can outlast its deadline while Codex refreshes its models; the
      // Runtime reports that check as an error it has not settled, and checks again.
      let settled = false;
      const catalog: Runtime["catalog"] = vi.fn(() =>
        Effect.sync(() => [
          settled
            ? provider()
            : {
                ...provider(),
                status: "error" as const,
                auth: { status: "unknown" as const },
                message: "Timed out while checking Codex app-server provider status.",
                models: [],
              },
        ]),
      );
      const opening = yield* resolveInboxModel({ catalog }, choice("codex"), "suggestion").pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      settled = true;
      yield* TestClock.adjust("200 millis");
      assert.deepEqual(yield* Fiber.join(opening), {
        instanceId: "codex",
        model: "default-model",
      });
      assert.strictEqual(
        vi.mocked(catalog).mock.calls.filter(([input]) => input?.refresh === true).length,
        1,
      );
      // An Agent whose check did answer, here that it needs signing in, stays unavailable at once.
      const signedOut = yield* resolveInboxModel(
        {
          catalog: () =>
            Effect.succeed([
              {
                ...provider(),
                status: "error" as const,
                auth: { status: "unauthenticated" as const },
              },
            ]),
        },
        choice("codex"),
      ).pipe(Effect.result);
      assert.strictEqual(signedOut._tag, "Failure");
      if (signedOut._tag === "Failure")
        assert.match(signedOut.failure.message, /configured Agent is unavailable/);
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
    assert.strictEqual(calls[0]?.messageFingerprint, inboxDispatchFingerprint(confirmed));
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
    const huge = new Uint8Array(6 * 1024 * 1024);
    const confirmed = {
      ...work(),
      images: [
        suggestionImage("shot", png),
        suggestionImage("vector", png),
        suggestionImage("trashed", png),
        suggestionImage("huge", huge),
        suggestionImage("detail", png),
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
        huge: { mimeType: "image/png", bytes: huge },
        detail: { mimeType: "image/jpeg", bytes: png },
      },
    });
    yield* drain;
    // A kind of image an Agent cannot read, or one no longer in the Library, stays on its Page;
    // an oversized one is fitted rather than left out.
    assert.deepEqual(calls[0]?.message.images, [
      {
        source: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        caption: "[Image #1]",
      },
      {
        source: `data:image/jpeg;base64,${Buffer.from(FITTED_JPEG).toString("base64")}`,
        caption: "[Image #4]",
      },
      {
        source: `data:image/jpeg;base64,${Buffer.from(png).toString("base64")}`,
        caption: "[Image #5]",
      },
    ]);
    assert.strictEqual(
      calls[0]?.message.text,
      `${confirmed.final_text}\n\n[Image #2], [Image #3] could not be attached.`,
    );
  }),
);

it.effect("hands busy follow-ups to the Runtime queue and does not starve a ninth chat", () =>
  Effect.gen(function* () {
    const review = {
      name: "review",
      path: "/repo/review/SKILL.md",
      cwd: "/repo",
      instanceId: "codex",
    };
    const removed = { ...review, name: "removed", path: "/repo/removed/SKILL.md" };
    const items = Array.from({ length: 9 }, (_, index) => ({
      ...work({ type: "send_to_chat", session_id: "session:one", prompt: "Follow up" }),
      skill_invocations: index === 0 ? [review, removed] : [],
      images: index === 0 ? [suggestionImage("missing", new Uint8Array([1]))] : [],
      proposal_id: `proposal:${index}`,
      message_id: `message:${index}`,
      thread_status: { status_type: "active" as const, active_flags: [] },
    }));
    const sendMessage = vi.fn<Runtime["sendMessage"]>(() =>
      Effect.succeed({ sequence: 5 } as never),
    );
    const complete = vi.fn(() => Effect.void);
    const { drain } = yield* delivery({
      session: () => session(true),
      runtime: {
        sendMessage,
        skillDestinationForSession: () => Effect.succeed({ instanceId: "codex", cwd: "/repo" }),
        skillsForWorkspace: () =>
          Effect.succeed([{ name: review.name, path: review.path, enabled: true }]),
      },
      inbox: {
        outbox: () => Effect.succeed(items),
        completeDispatch: complete,
      },
    });
    yield* drain;
    assert.strictEqual(sendMessage.mock.calls.length, 9);
    assert.isTrue(
      sendMessage.mock.calls.every(
        ([target]) => target.threadId === "thread:one" && target.mode === "queue",
      ),
    );
    assert.strictEqual(
      sendMessage.mock.calls[0]?.[0].message.text,
      `${items[0]!.final_text}\n\n[Image #1] could not be attached.`,
    );
    assert.strictEqual(
      sendMessage.mock.calls[0]?.[0].messageFingerprint,
      inboxDispatchFingerprint(items[0]!),
    );
    assert.deepEqual(sendMessage.mock.calls[0]?.[0].message.skillInvocations, [review]);
    assert.deepEqual(complete.mock.calls[0], [items[0], "thread:one", ["removed"]]);
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

it.effect("starts an Inbox chat where this host runs the Project's work", () =>
  Effect.gen(function* () {
    // A hosted repository Project has no local source path; only the execution owner knows its clone.
    const asked: Array<readonly [string | null, string | undefined]> = [];
    const launches: AgentRuntimeLaunch[] = [];
    const complete = vi.fn(() => Effect.void);
    const { drain } = yield* delivery({
      session: () => session(),
      runtime: {
        executionWorkspace: (projectId, chat) =>
          Effect.sync(() => {
            asked.push([projectId, chat]);
            return { available: true, workspaceRoot: "/execution/clone", sourceRoots: [] };
          }),
        launch: (input) =>
          Effect.sync(() => {
            launches.push(input);
            return { threadId: "thread:one" } as never;
          }),
      },
      inbox: {
        outbox: () => Effect.succeed(launches.length === 0 ? [work()] : []),
        completeDispatch: complete,
      },
    });
    yield* drain;
    assert.deepEqual(asked, [["project:one", "new"]]);
    assert.strictEqual(launches[0]?.projectId, "project:one");
    assert.strictEqual(complete.mock.calls.length, 1);
  }),
);

it.effect("delivers an Inbox chat without a Project to the host's projectless workspace", () =>
  Effect.gen(function* () {
    const asked: Array<string | null> = [];
    const launches: AgentRuntimeLaunch[] = [];
    const complete = vi.fn(() => Effect.void);
    const confirmed = {
      ...work({ type: "new_chat", project_id: null, prompt: "Note this" }),
      project_id: null,
    };
    const { drain } = yield* delivery({
      session: () => ({ ...session(), projectId: null }),
      runtime: {
        executionWorkspace: (projectId) =>
          Effect.sync(() => {
            asked.push(projectId);
            return { available: true, workspaceRoot: "/execution/tasks", sourceRoots: [] };
          }),
        launch: (input) =>
          Effect.sync(() => {
            launches.push(input);
            return { threadId: "thread:one" } as never;
          }),
      },
      inbox: {
        outbox: () => Effect.succeed(launches.length === 0 ? [confirmed] : []),
        completeDispatch: complete,
      },
    });
    yield* drain;
    assert.deepEqual(asked, [null]);
    assert.strictEqual(launches[0]?.projectId, null);
    assert.deepEqual(complete.mock.calls[0], [confirmed, "thread:one", []]);
  }),
);

it.effect("a Project this host cannot run fails visibly with the host's reason", () =>
  Effect.gen(function* () {
    const fail = vi.fn(() => Effect.void);
    const launch = vi.fn(() => Effect.die("must not submit"));
    const send = vi.fn(() => Effect.die("must not submit"));
    const reason = "Map this repository on the Host before starting work";
    const asked: Array<string | undefined> = [];
    const confirmed = work();
    const followUp = {
      ...work({ type: "send_to_chat", session_id: "session:one", prompt: "Follow up" }),
      proposal_id: "proposal:two",
    };
    const { drain } = yield* delivery({
      session: () => session(true),
      runtime: {
        executionWorkspace: (_projectId, chat) =>
          Effect.sync(() => {
            asked.push(chat);
            return { available: false, reason };
          }),
        launch,
        sendMessage: send,
      },
      inbox: { outbox: () => Effect.succeed([confirmed, followUp]), failDispatch: fail },
    });
    yield* drain;
    assert.strictEqual(launch.mock.calls.length, 0);
    assert.strictEqual(send.mock.calls.length, 0);
    // An existing chat keeps its own directory; only its Project's admission is checked.
    assert.deepEqual(asked, ["new", "existing"]);
    assert.deepEqual(fail.mock.calls, [
      [confirmed, reason, "unavailable"],
      [followUp, reason, "unavailable"],
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
      final_text: "Read [Image #1] and [Image #2]",
      images: [suggestionImage("missing", FITTED_JPEG), suggestionImage("present", FITTED_JPEG)],
    };
    const start = vi.fn(() =>
      Effect.sync(() => {
        calls.push("start");
      }).pipe(Effect.andThen(Effect.fail(applicationError()))),
    );
    const complete = vi.fn(() => Effect.void);
    const { drain } = yield* delivery({
      session: () => nativeSession,
      files: { present: { mimeType: "image/jpeg", bytes: FITTED_JPEG } },
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
      Effect.provideService(NativeConversationDelivery, {
        start,
      } as unknown as NativeConversationDelivery["Service"]),
    );
    yield* drain;
    yield* drain;
    assert.deepEqual(calls, ["persist-unknown", "start"]);
    assert.strictEqual(start.mock.calls.length, 1);
    const delivered = `${confirmed.final_text}\n\n[Image #1] could not be attached.`;
    assert.deepEqual(start.mock.calls[0], [
      "thread:remote",
      delivered,
      {
        clientUserMessageId: confirmed.message_id,
        promptInput: {
          text: delivered,
          agentConfigs: [],
          images: [
            {
              source: `data:image/jpeg;base64,${Buffer.from(FITTED_JPEG).toString("base64")}`,
              caption: "[Image #2]",
            },
          ],
        },
      },
    ]);
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
      Effect.provideService(NativeConversationDelivery, {
        start,
      } as unknown as NativeConversationDelivery["Service"]),
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

const suggestionImage = (id: string, bytes: Uint8Array) => ({
  source: `nodex://files/${id}`,
  file_id: id,
  content_hash: createHash("sha256").update(bytes).digest("hex"),
});

it.effect(
  "a handoff rejects changed File bytes and preserves unavailable markers on admission replay",
  () =>
    Effect.gen(function* () {
      const original = new Uint8Array([137, 80, 78, 71]);
      const changed = new Uint8Array([255, 216, 255]);
      const files: Record<string, { mimeType: string; bytes: Uint8Array }> = {
        changed: { mimeType: "image/png", bytes: changed },
        present: { mimeType: "image/png", bytes: original },
      };
      const confirmed: CoreInboxDispatchWork = {
        ...work(),
        final_text: "Read [Image #1], [Image #2] and [Image #3]",
        images: [
          suggestionImage("missing", original),
          suggestionImage("present", original),
          suggestionImage("changed", original),
        ],
      };
      let accepted = false;
      const calls: AgentRuntimeLaunch[] = [];
      const complete = vi.fn(() => Effect.void);
      const input = {
        session: () => session(),
        files,
        inbox: { outbox: () => Effect.succeed([confirmed]), completeDispatch: complete },
        runtime: {
          launch: (input: AgentRuntimeLaunch) =>
            Effect.suspend(() => {
              calls.push(input);
              accepted = true;
              return Effect.fail(applicationError());
            }),
          messageAdmission: () =>
            Effect.succeed(
              accepted
                ? {
                    status: "accepted" as const,
                    sequence: 1,
                    error: null,
                    runtimeId: "runtime:one",
                    threadId: "thread:one",
                    messageId: confirmed.message_id,
                    commandId: "command:one",
                  }
                : null,
            ),
        },
      };
      yield* delivery(input).pipe(Effect.flatMap(({ drain }) => drain));
      files.missing = { mimeType: "image/png", bytes: original };
      files.changed = { mimeType: "image/png", bytes: original };
      // A recreated worker reconciles the same receipt before re-reading mutable Library state.
      yield* delivery(input).pipe(Effect.flatMap(({ drain }) => drain));
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.message.messageId, confirmed.message_id);
      assert.strictEqual(calls[0]?.messageFingerprint, inboxDispatchFingerprint(confirmed));
      assert.strictEqual(
        calls[0]?.message.text,
        `${confirmed.final_text}\n\n[Image #1], [Image #3] could not be attached.`,
      );
      assert.deepEqual(calls[0]?.message.images, [
        {
          source: `data:image/png;base64,${Buffer.from(original).toString("base64")}`,
          caption: "[Image #2]",
        },
      ]);
      assert.isAtLeast(complete.mock.calls.length, 1);
    }),
);

it.effect("delivers a frozen Inbox question answer as the person and reconciles a lost reply", () =>
  Effect.gen(function* () {
    const confirmed: CoreInboxDispatchWork = {
      ...work({
        type: "send_to_chat",
        session_id: "session",
        prompt: "Small change",
        additions: [],
      }),
      session_id: "session",
      target_execution_ref: { runtime_id: "runtime", thread_id: "thread" },
      question_response: {
        request_id: "question",
        run_id: "run",
        question_id: "choice",
        answer: "Small change",
      },
    };
    let accepted = false;
    const respond = vi.fn<Runtime["respond"]>(() =>
      Effect.sync(() => {
        accepted = true;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new AgentRuntimeApplicationError({ operation: "respond", message: "reply lost" }),
          ),
        ),
      ),
    );
    const complete = vi.fn(() => Effect.void);
    const send = vi.fn<Runtime["sendMessage"]>();
    const input = {
      runtime: {
        respond,
        sendMessage: send,
        responseAdmission: () =>
          Effect.succeed(
            accepted ? { status: "accepted" as const, sequence: 1, error: null } : null,
          ),
      },
      inbox: { outbox: () => Effect.succeed([confirmed]), completeDispatch: complete },
      session: () => {
        throw new Error("Receipt reconciliation must precede live session reads");
      },
    };
    yield* (yield* delivery(input)).drain;
    yield* (yield* delivery(input)).drain;
    assert.lengthOf(respond.mock.calls, 1);
    assert.isEmpty(send.mock.calls);
    assert.deepInclude(respond.mock.calls[0]![0], {
      sessionId: "session",
      threadId: "thread",
      requestId: "question",
      runId: "run",
      submissionId: confirmed.message_id,
      requirePending: true,
      answers: { choice: "Small change" },
    });
    assert.isUndefined(respond.mock.calls[0]![0].respondedBy);
    assert.isAtLeast(complete.mock.calls.length, 1);
  }),
);

it.effect.each(["new_chat", "send_to_chat", "question"] as const)(
  "retains a held %s dispatch until resume",
  (kind) =>
    Effect.gen(function* () {
      let held = true;
      let pending = true;
      let delivered = 0;
      const confirmed = {
        ...work(
          kind === "new_chat"
            ? undefined
            : { type: "send_to_chat", session_id: "session:one", prompt: "Follow up" },
        ),
        ...(kind === "question"
          ? {
              question_response: {
                request_id: "request",
                question_id: "question",
                answer: "Yes",
                run_id: "run",
              },
            }
          : {}),
      };
      const fail = vi.fn(() => Effect.void);
      const owner = yield* delivery({
        session: () => session(kind !== "new_chat"),
        inbox: {
          executionHeld: () => Effect.succeed(held),
          outbox: () => Effect.succeed(pending ? [confirmed] : []),
          completeDispatch: () =>
            Effect.sync(() => {
              pending = false;
            }),
          failDispatch: fail,
        },
        runtime: {
          launch: () =>
            Effect.sync(() => {
              delivered++;
              return { threadId: "thread:one" } as never;
            }),
          sendMessage: () =>
            Effect.sync(() => {
              delivered++;
              return {} as never;
            }),
          responseAdmission: () => Effect.succeed(null),
          respond: () =>
            Effect.sync(() => {
              delivered++;
              return {} as never;
            }),
        },
      });
      yield* owner.drain;
      assert.equal(delivered, 0);
      assert.isTrue(pending);
      assert.equal(fail.mock.calls.length, 0);
      held = false;
      yield* owner.drain;
      yield* owner.drain;
      assert.equal(delivered, 1);
      assert.isFalse(pending);
      assert.equal(fail.mock.calls.length, 0);
    }),
);
