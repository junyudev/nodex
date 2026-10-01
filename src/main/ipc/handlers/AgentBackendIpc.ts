import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { IpcEvents } from "../../../shared/ipc-api";
import { createUuidV7, isUuidV7 } from "../../../shared/uuid-v7";
import { CLAUDE_EFFORT_LEVELS } from "../../../shared/claude-models";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { MainConfig } from "../../app/MainConfig";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import {
  AcpRendererObservationRegistry,
  type AcpRendererObservationChanges,
} from "./AcpRendererObservationRegistry";
import { makeClaudeDiscoveryRequests } from "./ClaudeDiscoveryRequests";

const id = z.string().trim().min(1).max(512);
const prompt = z
  .string()
  .trim()
  .max(256 * 1024);
const Images = z
  .array(
    z
      .object({
        source: z
          .string()
          .min(1)
          .max(7 * 1024 * 1024),
        caption: z.string().max(8192).optional(),
      })
      .strict(),
  )
  .max(20)
  .refine(
    (images) => images.reduce((total, image) => total + image.source.length, 0) <= 28 * 1024 * 1024,
  );
const OpenInput = z.object({ threadId: id }).strict();
const NativePermissionMode = z.enum(["auto", "guardian-approvals", "full-access"]);
const NativePermissionSelection = z.tuple([id.nullable(), NativePermissionMode]);
const ClaudeModelsInput = z
  .object({
    projectId: id.nullable(),
    instanceConfigId: id,
    requestId: z.string().refine(isUuidV7).optional(),
    forceReload: z.boolean().optional(),
  })
  .strict();
const ClaudeDiscoveryInput = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("project"), instanceConfigId: id, projectId: id.nullable() })
        .strict(),
      z.object({ kind: z.literal("thread"), threadId: id }).strict(),
    ]),
    requestId: z.string().refine(isUuidV7).optional(),
    forceReload: z.boolean().optional(),
  })
  .strict();
const Selection = z
  .object({
    model: id,
    effort: z.enum(["default", ...CLAUDE_EFFORT_LEVELS]),
    fast: z.boolean().optional(),
    thinking: z.boolean().optional(),
    context: z
      .string()
      .regex(/^\d+[km]$/u)
      .optional(),
  })
  .strict();
const IntelligenceInput = z.object({ threadId: id, selection: Selection }).strict();
const ControlInput = z.discriminatedUnion("kind", [
  z
    .object({
      threadId: id,
      kind: z.literal("steer"),
      prompt,
      images: Images.optional(),
      clientUserMessageId: z.string().refine(isUuidV7),
    })
    .strict(),
  z.object({ threadId: id, kind: z.literal("stop-task"), taskId: id }).strict(),
  z
    .object({
      threadId: id,
      kind: z.literal("rollback"),
      numTurns: z.number().int().min(1).max(1000),
    })
    .strict(),
  z.object({ threadId: id, kind: z.literal("compact") }).strict(),
  z
    .object({
      threadId: id,
      kind: z.literal("permission-mode"),
      mode: NativePermissionMode,
    })
    .strict(),
  z
    .object({
      threadId: id,
      kind: z.literal("load-older"),
      before: id.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
]);
const ForkInput = z.object({ threadId: id, nativeMessageId: id }).strict();
const HistoryImageInput = z
  .object({
    threadId: id,
    expectedSessionId: id,
    nativeMessageId: id,
    index: z.number().int().min(0).max(9999),
  })
  .strict();
const ToolOutputInput = z
  .object({ threadId: id, expectedSessionId: id, nativeMessageId: id, toolUseId: id })
  .strict();
const BoundedJson = z
  .json()
  .refine(
    (value) => JSON.stringify(value).length <= 64 * 1024,
    "Interaction response is too large",
  );
const uuidV7 = z.string().refine(isUuidV7, "Expected canonical lowercase UUID-v7");
const CancelDiscoveryInput = z.object({ requestId: uuidV7 }).strict();
const StartInput = z
  .object({
    sessionId: id,
    instanceConfigId: id,
    backendKind: z.enum(["acp", "claude"]),
    model: id.optional(),
    effort: z.enum(["default", ...CLAUDE_EFFORT_LEVELS]).optional(),
    selection: Selection.optional(),
    mode: z.enum(["default", "plan"]).optional(),
    runInTarget: z.enum(["localProject", "newWorktree"]).optional(),
    runInEnvironmentPath: id.nullable().optional(),
    worktreeStartingState: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z.literal("branch"),
            branchName: id,
            remoteRef: id.optional(),
            onMissing: z.enum(["error", "create-branch"]).optional(),
          })
          .strict(),
        z.object({ type: z.literal("working-tree") }).strict(),
      ])
      .optional(),
    prompt,
    images: Images.optional(),
    firstSubmission: z
      .object({
        launchId: uuidV7,
        clientUserMessageId: uuidV7,
      })
      .strict(),
  })
  .strict();
const PromptInput = z
  .object({
    threadId: id,
    prompt,
    images: Images.optional(),
    clientUserMessageId: uuidV7.optional(),
  })
  .strict();
const ModeInput = z.object({ threadId: id, modeId: id }).strict();
const ConfigInput = z
  .object({ threadId: id, configId: id, value: z.union([z.string().max(16_384), z.boolean()]) })
  .strict();
const RespondInput = z
  .object({
    threadId: id,
    requestId: id,
    response: z.discriminatedUnion("decision", [
      z.object({ decision: z.enum(["allow", "allow-for-session", "deny"]) }).strict(),
      z.object({ decision: z.literal("dialog"), result: BoundedJson }).strict(),
      z
        .object({
          decision: z.literal("elicitation"),
          action: z.enum(["accept", "decline", "cancel"]),
          content: z.record(z.string().max(1024), BoundedJson).optional(),
        })
        .strict(),
      z
        .object({
          decision: z.literal("answer"),
          answers: z
            .record(z.string().max(8192), z.string().max(16384))
            .refine((value) => Object.keys(value).length <= 8),
        })
        .strict(),
    ]),
  })
  .strict();
const AuthenticateInput = z.object({ threadId: id, methodId: id }).strict();

export class AgentBackendIpcError extends Schema.TaggedError<AgentBackendIpcError>()(
  "AgentBackendIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const failure = (operation: string, cause: unknown) =>
  new AgentBackendIpcError({ operation, cause });

export const live: Layer.Layer<
  never,
  never,
  AgentBackendApplication | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const application = yield* AgentBackendApplication;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const discoveryRequests = yield* makeClaudeDiscoveryRequests;
    const observers = new AcpRendererObservationRegistry<IpcMainInvokeEvent["sender"]>();
    const runObservationLifecycle = yield* FiberSet.makeRuntime<never, void, never>();
    const applyObservationChanges = (changes: AcpRendererObservationChanges) =>
      Effect.forEach(changes.unobservedThreadIds, application.unobserveAgentSession, {
        discard: true,
      }).pipe(
        Effect.andThen(
          Effect.forEach(changes.observedThreadIds, application.observeAgentSession, {
            discard: true,
          }),
        ),
        Effect.asVoid,
      );
    const releaseObserver = (ownerId: number) =>
      Effect.sync(() => observers.release(ownerId)).pipe(
        Effect.flatMap(applyObservationChanges),
        Effect.uninterruptible,
      );
    const closeObservers = Effect.sync(() => observers.close()).pipe(
      Effect.flatMap(applyObservationChanges),
    );
    yield* Effect.addFinalizer(() => closeObservers);
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: windows.has(event.sender.id),
              senderType: event.sender.getType(),
              senderUrl: event.senderFrame?.url ?? "",
              isMainFrame: event.senderFrame === event.sender.mainFrame,
            })
          ) {
            throw new Error("Agent Backend access requires an active Nodex window");
          }
        },
        catch: (cause) => failure("authorize-renderer", cause),
      });
    const parse = <A>(operation: string, schema: z.ZodType<A>, value: unknown) =>
      Effect.try({ try: () => schema.parse(value), catch: (cause) => failure(operation, cause) });
    const handle = <A, B>(
      event: IpcMainInvokeEvent,
      operation: string,
      schema: z.ZodType<A>,
      value: unknown,
      evaluate: (input: A) => Effect.Effect<B, unknown>,
    ) =>
      authorize(event).pipe(
        Effect.andThen(parse(`parse-${operation}`, schema, value)),
        Effect.flatMap(evaluate),
        Effect.mapError((cause) =>
          cause instanceof AgentBackendIpcError ? cause : failure(operation, cause),
        ),
      );
    const threadId = (event: IpcMainInvokeEvent, operation: string, value: unknown) =>
      authorize(event).pipe(
        Effect.andThen(parse(`parse-${operation}`, id, value)),
        Effect.mapError((cause) =>
          cause instanceof AgentBackendIpcError ? cause : failure(operation, cause),
        ),
      );
    const interruptWhenRendererIsDestroyed = <A, E, R>(
      event: IpcMainInvokeEvent,
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.raceFirst(
        operation,
        Effect.callback<never>((resume) => {
          if (event.sender.isDestroyed()) {
            resume(Effect.interrupt);
            return;
          }
          const interrupt = (): void => resume(Effect.interrupt);
          event.sender.once("destroyed", interrupt);
          return Effect.sync(() => event.sender.removeListener("destroyed", interrupt));
        }),
      );

    yield* ipc.handlePlainCommand("agent-backend:thread:start", (event, input) =>
      handle(event, "thread.start", StartInput, input, application.startAgentThread),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:open", (event, input) =>
      handle(event, "session.open", OpenInput, input, application.openAgentSession),
    );
    yield* ipc.handleQuery("agent-backend:permission-mode:get", (event, projectId) =>
      handle(
        event,
        "permission.read",
        id.nullable(),
        projectId,
        application.readNativePermissionMode,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:permission-mode:set", (event, projectId, mode) =>
      handle(
        event,
        "permission.write",
        NativePermissionSelection,
        [projectId, mode],
        ([scope, selected]) => application.setNativePermissionMode(scope, selected),
      ),
    );
    yield* ipc.handleQuery("agent-backend:session:read", (event, value) =>
      threadId(event, "session.read", value).pipe(Effect.flatMap(application.readAgentSession)),
    );
    yield* ipc.handleQuery("agent-backend:claude:models", (event, input) =>
      handle(event, "claude.models", ClaudeModelsInput, input, (parsed) =>
        discoveryRequests.run(
          event.sender.id,
          parsed.requestId ?? createUuidV7(),
          interruptWhenRendererIsDestroyed(event, application.claudeModels(parsed)),
        ),
      ),
    );
    yield* ipc.handleQuery("agent-backend:claude:discover", (event, input) =>
      handle(event, "claude.discover", ClaudeDiscoveryInput, input, (parsed) =>
        discoveryRequests.run(
          event.sender.id,
          parsed.requestId ?? createUuidV7(),
          interruptWhenRendererIsDestroyed(event, application.claudeDiscovery(parsed)),
        ),
      ),
    );
    yield* ipc.handleControl("agent-backend:claude:cancel-discovery", (event, input) =>
      handle(event, "claude.cancel-discovery", CancelDiscoveryInput, input, (parsed) =>
        discoveryRequests.cancel(event.sender.id, parsed.requestId),
      ),
    );
    yield* ipc.handleQuery("agent-backend:session:history-image", (event, value) =>
      handle(event, "history-image", HistoryImageInput, value, application.readAgentHistoryImage),
    );
    yield* ipc.handleQuery("agent-backend:session:tool-output", (event, value) =>
      handle(event, "tool-output", ToolOutputInput, value, application.readAgentToolOutput),
    );
    yield* ipc.handleQuery("agent-backend:session:inspect", (event, value) =>
      threadId(event, "session.inspect", value).pipe(
        Effect.flatMap(application.inspectAgentSession),
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:set-intelligence", (event, input) =>
      handle(
        event,
        "session.intelligence",
        IntelligenceInput,
        input,
        application.setAgentIntelligence,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:control", (event, input) =>
      handle(event, "session.control", ControlInput, input, application.controlAgentSession),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:fork", (event, input) =>
      handle(event, "session.fork", ForkInput, input, application.forkAgentSession),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:generate-title", (event, value) =>
      threadId(event, "session.title", value).pipe(Effect.flatMap(application.generateAgentTitle)),
    );
    yield* ipc.handleControl("agent-backend:session:observe", (event, value) =>
      threadId(event, "session.observe", value).pipe(
        Effect.flatMap((observedThreadId) =>
          Effect.try({
            try: () => {
              const onDestroyed = () => {
                void runObservationLifecycle(releaseObserver(event.sender.id));
              };
              event.sender.once("destroyed", onDestroyed);
              return observers.observe(event.sender.id, event.sender, observedThreadId, () =>
                event.sender.removeListener("destroyed", onDestroyed),
              );
            },
            catch: (cause) => failure("session.observe", cause),
          }).pipe(Effect.flatMap(applyObservationChanges), Effect.uninterruptible),
        ),
        Effect.asVoid,
      ),
    );
    yield* ipc.handleControl("agent-backend:session:unobserve", (event, value) =>
      threadId(event, "session.unobserve", value).pipe(
        Effect.flatMap((observedThreadId) =>
          Effect.sync(() => observers.unobserve(event.sender.id, observedThreadId)).pipe(
            Effect.flatMap(applyObservationChanges),
            Effect.uninterruptible,
          ),
        ),
        Effect.asVoid,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:prompt", (event, input) =>
      handle(event, "session.prompt", PromptInput, input, application.promptAgentSession),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:cancel", (event, value) =>
      threadId(event, "session.cancel", value).pipe(Effect.flatMap(application.cancelAgentSession)),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:set-mode", (event, input) =>
      handle(event, "session.set-mode", ModeInput, input, application.setAgentMode),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:set-config-option", (event, input) =>
      handle(
        event,
        "session.set-config-option",
        ConfigInput,
        input,
        application.setAgentConfigOption,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:authenticate", (event, input) =>
      handle(
        event,
        "session.authenticate",
        AuthenticateInput,
        input,
        application.authenticateAgentSession,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:session:close", (event, value) =>
      threadId(event, "session.close", value).pipe(Effect.flatMap(application.closeAgentSession)),
    );

    yield* ipc.handlePlainCommand("agent-backend:session:respond", (event, input) =>
      handle(event, "session.respond", RespondInput, input, ({ threadId, requestId, response }) =>
        application.respondToInteraction(threadId, requestId, response),
      ),
    );

    yield* application.changes.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          for (const [webContentsId, sender] of observers.matching(event.threadId)) {
            const delivered = safeSendToWebContents(
              sender,
              "agent-backend:session-changed" satisfies keyof IpcEvents,
              [event],
            );
            if (!delivered && sender.isDestroyed()) yield* releaseObserver(webContentsId);
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
