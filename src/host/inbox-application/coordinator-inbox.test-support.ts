import { createHash } from "node:crypto";
import type { LibraryModuleReadRequest } from "../../shared/library-module";
import type { ReadFileBytesInput } from "../../shared/library-files";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import { DEFAULT_INBOX_SETTINGS, type InboxSettings } from "../../shared/inbox";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import {
  AgentRuntimeApplication,
  type AgentRuntimeApplicationError,
import { CoordinatorSession } from "../coordinator/CoordinatorSession";
import {
  InboxApplication,
  make as makeInboxApplication,
  type InboxSuggestionSettlement,
} from "./InboxApplication";
import { make } from "./InboxDispatcher";

type Runtime = AgentRuntimeApplication["Service"];
export const routingRequest = (id = "one"): CoreInboxSuggestionRequest => ({
  delivery: null,
  request_id: `request:${id}`,
  generation: 1,
  mode: "auto",
  page_ids: [`page:${id}`],
  basis: [{ page_id: `page:${id}`, content_hash: "a".repeat(64) }],
  proposal_id: null,
  expected_revision: null,
  correction: null,
  context: {
    scope: { kind: "library" },
    entries: [
      {
        page_id: `page:${id}`,
        page_key: "IN-1",
        body: "Fix README",
        images: [],
        source: { kind: "user" },
        kind: null,
        submitted_at: "2026-11-03T00:00:00.000Z",
        scope: { kind: "library" },
        basis: { page_id: `page:${id}`, content_hash: "a".repeat(64) },
        title_provisional: true,
        reply_to: null,
      },
    ],
    projects: [],
    sessions: [],
    open_proposals: [],
  },
});
export const keepOutput = (request: CoreInboxSuggestionRequest) => ({
  request_id: request.request_id,
  generation: request.generation,
  titles: [],
  suggestions: request.page_ids.map((page_id) => ({
    explicit_request: false,
    page_ids: [page_id],
    kind: "note",
    action: "keep",
    project_id: null,
    session_id: null,
    prompt: null,
    additions: [],
    chat_instance_id: null,
    chat_model: null,
    chat_effort: null,
    summary: "Keep the reference",
    rationale: null,
  })),
});
export const invocation = (
  args: Record<string, unknown>,
  name = "inbox_suggest",
  callId = "call",
): AppToolInvocation => ({
  name,
  arguments: args,
  caller: {
    threadId: "thread:nodex",
    turnId: "run",
    callId,
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
});

export const routingFixture = Effect.fn("CoordinatorInbox.fixture")(function* (
  requests: CoreInboxSuggestionRequest[] = [routingRequest()],
  files: Readonly<Record<string, { readonly mimeType: string; readonly bytes: Uint8Array }>> = {},
) {
  const at = yield* Clock.currentTimeMillis;
  let current: InboxSettings = {
    ...DEFAULT_INBOX_SETTINGS,
    suggestionConcurrency: 3,
    suggestions: "on_request",
  };
  let caller = "nodex";
  let bound = "nodex";
  const pending = new Map(requests.map((request) => [request.request_id, request]));
  const settlements: InboxSuggestionSettlement[] = [];
  const commands: ProjectWorkspaceApplyInput[] = [];
  const admissions = new Set<string>();
  let rejection: string | null = null;
  let failureMessage: string | null = null;
  const completedRuns = new Set<string>();
  let runStartedAt: number | null = at;
  const posted: unknown[] = [];
  let sequence = 0;
  const authority: () => NodexAgentTurnContext = () => ({
    threadId: `thread:${caller}`,
    rootThreadId: `thread:${caller}`,
    turnId: "run",
    actorProjectId: null,
    libraryId: "library",
    storeEpoch: "epoch",
    admittedAtMs: at,
    runtime: { sessionId: caller, runtimeId: "runtime", turnKind: "run" },
  });
  let routingStatus: InboxApplication["Service"]["routingStatus"];
  const inbox = {
    prepareSuggestions: () => Effect.void,
    autoConfirm: Effect.void,
    cancelledRoutingDeliveries: () => Effect.succeed([]),
    suggestionRequests: (limit: number) => Effect.succeed([...pending.values()].slice(0, limit)),
    suggestionRequest: (id: string) => Effect.succeed(pending.get(id) ?? null),
    beginRouting: (request: CoreInboxSuggestionRequest, sessionId: string) =>
      Effect.sync(() => {
        if ([...pending.values()].filter((request) => request.delivery).length >= 3)
          throw new Error("capacity");
        pending.set(request.request_id, {
          ...request,
          delivery: {
            coordinator_session_id: sessionId,
            run_started_at_ms: null,
            last_refusal: null,
            handed_over_at_ms: at,
          },
        });
      }),
    recordRoutingRefusal: (request: CoreInboxSuggestionRequest, reason: string) =>
      application.recordRoutingRefusal(request, reason),
    routingStatus: (request: CoreInboxSuggestionRequest) => routingStatus(request),
    settleSuggestion: (settlement: InboxSuggestionSettlement) =>
      Effect.sync(() => {
        settlements.push(settlement);
        pending.delete(settlement.request_id);
      }),
    entry: () =>
      Effect.succeed({ title: "Ready", body: "README is ready", scope: { kind: "library" } }),
  };
  const admissionFixture = createAppToolAdmissionFixture(at);
  const seen = new Set<string>();
  const postPages = new Map<string, string>();
  const core = {
    workspace: {
      read: (read: ProjectWorkspaceRead) =>
        Effect.sync(() => {
          if (read.kind !== "inbox_suggestion_request") throw new Error("Unexpected routing read");
          return {
            value: {
              kind: "inbox_suggestion_request",
              request: pending.get(read.request_id) ?? null,
            },
          };
        }),
      admitToolOperation: admissionFixture.admitToolOperation,
      apply: (input: ProjectWorkspaceApplyInput) =>
        Effect.sync(() => {
          if (input.intent.kind === "record_inbox_routing_refusal") {
            const current = pending.get(input.intent.request_id)!;
            pending.set(current.request_id, {
              ...current,
              delivery: {
                ...current.delivery!,
                last_refusal: input.intent.reason,
              },
            });
            return { receipt: { duplicate: false } };
          }
          if (input.intent.kind === "start_inbox_routing_run") {
            const { request_id, generation, coordinator_session_id, run_started_at_ms } =
              input.intent;
            const current = pending.get(request_id);
            if (
              !current?.delivery ||
              current.generation !== generation ||
              current.delivery.coordinator_session_id !== coordinator_session_id
            )
              throw new Error("Stale routing start");
            pending.set(request_id, {
              ...current,
              delivery: {
                ...current.delivery,
                run_started_at_ms: current.delivery.run_started_at_ms ?? run_started_at_ms,
              },
            });
            return { receipt: { duplicate: false } };
          }
          commands.push(input);
          const duplicate = seen.has(input.operationId);
          seen.add(input.operationId);
          const intent = input.intent.kind === "agent_command" ? input.intent.intent : null;
          const existing = postPages.get(key);
          return {
            receipt: { duplicate },
          };
        }),
    },
  };
  let execute: ((input: AppToolInvocation) => Effect.Effect<CallToolResult>) | undefined;
  // The mock Runtime admits first, then invokes the real app-tool handler.
  let onSend: (
    input: Parameters<Runtime["sendMessage"]>[0],
  ) => Effect.Effect<unknown, AgentRuntimeApplicationError> = (input) =>
    Effect.gen(function* () {
      const data = JSON.parse(input.message.text.split("JSON data:\n")[1]!);
      const request = pending.get(data.request.request_id)!;
      yield* execute!(invocation(keepOutput(request), "inbox_suggest", `call:${++sequence}`));
    });
  const send = vi.fn<Runtime["sendMessage"]>((input) =>
    Effect.gen(function* () {
      admissions.add(input.message.messageId);
      yield* onSend(input);
      return {} as Effect.Success<ReturnType<Runtime["sendMessage"]>>;
    }),
  );
  const catalog: Runtime["catalog"] = () =>
    Effect.succeed([
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        version: "test",
        auth: { status: "authenticated" },
        checkedAt: "2026-11-03T00:00:00.000Z",
        models: [
          { slug: "model", name: "Model", isDefault: true, isCustom: false, capabilities: {} },
        ],
        skills: [],
        slashCommands: [],
      },
    ]);
  const runtime = {
    catalog,
    runOutcome: ({ messageId }: { messageId: string }) =>
      Effect.sync(() =>
        !admissions.has(messageId)
          ? null
          : completedRuns.has(messageId)
            ? {
                status: "completed",
                startedAt: runStartedAt === null ? null : new Date(runStartedAt).toISOString(),
              }
            : failureMessage === null
              ? {
                  status: "running",
                  startedAt: runStartedAt === null ? null : new Date(runStartedAt).toISOString(),
                }
              : { status: "failed", failureMessage },
      ),
    messageAdmission: ({ messageId }: { messageId: string }) =>
      Effect.succeed(
        rejection !== null
          ? { status: "rejected", error: rejection, threadId: "thread:nodex" }
          : admissions.has(messageId)
            ? { status: "accepted", threadId: "thread:nodex" }
            : null,
      ),
    sendMessage: send,
  };
  const services = Layer.mergeAll(
    Layer.succeed(InboxApplication, inbox as never),
    Layer.succeed(AgentRuntimeApplication, runtime as never),
    Layer.succeed(CoordinatorSession, {
      ensure: () => Effect.succeed(bound),
      isCoordinator: (id: string) => Effect.succeed(id === bound),
    } as never),
    Layer.succeed(ApplicationSettings, {
      snapshot: () => Effect.succeed({ inbox: current }),
    } as never),
    Layer.succeed(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Layer.succeed(CoreModules, core as never),
    Layer.succeed(NodexEntryNotifications, {
      posted: (post: unknown) =>
        Effect.sync(() => {
          posted.push(post);
        }),
    } as never),
    Layer.succeed(LibraryModule, {
      read: (_routing: unknown, request: LibraryModuleReadRequest) =>
        Effect.sync(() => {
          if (request.read.mode !== "file_versions") throw new Error("Expected File versions");
          const file = files[request.read.file_id];
          return {
            ok: true,
            value: {
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
          };
        }),
      readFileBlob: (_routing: unknown, request: ReadFileBytesInput) =>
        files[request.fileId]
          ? Effect.succeed(files[request.fileId])
          : Effect.die("File unavailable"),
    } as never),
    Layer.succeed(NativePromptImages, {
      validate: () => Effect.void,
      fit: (images: readonly PromptImageBytes[]) =>
        Effect.succeed(
          images.map((image) => ({
            mediaType: image.mediaType,
            data: Buffer.from(image.bytes).toString("base64"),
          })),
        ),
    } as never),
  );
  const application = yield* makeInboxApplication.pipe(
    Effect.provide(services),
    Effect.provideService(StoreAdministration, { requestErasure: Effect.void } as never),
  );
  routingStatus = application.routingStatus;
  const tool = yield* makeWithCapture(() => Effect.succeed(authority())).pipe(
    Effect.provide(services),
  );
  execute = tool;
  const worker = make.pipe(Effect.provide(services));
  return {
    setRunStartedAt: (value: number | null) => {
      runStartedAt = value;
    },
    worker,
    completeRun: (messageId: string) => {
      completedRuns.add(messageId);
    },
    tool,
    pending,
    send,
    settlements,
    commands,
    admissions,
    rejectAdmission: (message: string) => {
      rejection = message;
    },
    failRun: (message: string) => {
      failureMessage = message;
    },
    posted,
    catalog,
    services,
    setCaller: (id: string) => {
      caller = id;
    },
    reset: () => {
      bound = "replacement";
    },
    setSuggestions: (suggestions: InboxSettings["suggestions"]) => {
      current = { ...current, suggestions };
    },
    setChooseModels: (suggestionsChooseModels: boolean) => {
      current = { ...current, suggestionsChooseModels };
    },
    setMode: (mode: InboxSettings["dispatchMode"]) => {
      current = { ...current, dispatchMode: mode };
    },
    setOnSend: (f: typeof onSend) => {
      onSend = f;
    },
  };
});
