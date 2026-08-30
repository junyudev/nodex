import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type {
  CodexAutomationRunsUpdatedEvent,
  PageOccurrenceActionInput,
  PageOccurrenceCompleteInput,
  PageOccurrenceUpdateInput,
} from "../../../shared/types";
import { MainConfig } from "../../app/MainConfig";
import { AutomationApplication } from "../../automation-application/AutomationApplication";
import { AutomationExecution } from "../../automation-application/AutomationExecution";
import { ConversationCommands } from "../../codex-application/ConversationCommands";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ScheduledAutomationRuntime } from "../../host-runtime/ScheduledAutomationRuntime";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class AutomationIpcError extends Schema.TaggedError<AutomationIpcError>()(
  "AutomationIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const requireOccurrence = (input: PageOccurrenceActionInput): void => {
  if (
    typeof input?.operationId !== "string" ||
    input.operationId.length === 0 ||
    input.operationId.length > 512 ||
    input.operationId !== input.operationId.trim()
  ) {
    throw new Error("Missing or invalid occurrence operationId");
  }
  if (typeof input.pageId !== "string" || input.pageId.length === 0) {
    throw new Error("Missing or invalid occurrence pageId");
  }
  if (
    !(input.occurrenceStart instanceof Date) ||
    !Number.isFinite(input.occurrenceStart.getTime())
  ) {
    throw new Error("Missing or invalid occurrenceStart");
  }
  if (
    input.source !== "calendar" &&
    input.source !== "page-detail" &&
    input.source !== "notification" &&
    input.source !== "api"
  ) {
    throw new Error("Missing or invalid occurrence source");
  }
};

const requireCompleteOccurrence = (input: PageOccurrenceCompleteInput): void => {
  requireOccurrence(input);
  if (
    typeof input.createdPageId !== "string" ||
    input.createdPageId.length === 0 ||
    input.createdPageId !== input.createdPageId.trim()
  ) {
    throw new Error("Missing or invalid occurrence createdPageId");
  }
};

const requireUpdateOccurrence = (input: PageOccurrenceUpdateInput): void => {
  requireOccurrence(input);
  if (input.scope !== "this" && input.scope !== "this-and-future" && input.scope !== "all") {
    throw new Error("Missing or invalid occurrence scope");
  }
  if (input.scope === "all" && "createdPageId" in input) {
    throw new Error("Occurrence scope all must not include createdPageId");
  }
  if (
    input.scope !== "all" &&
    (typeof input.createdPageId !== "string" ||
      input.createdPageId.length === 0 ||
      input.createdPageId !== input.createdPageId.trim())
  ) {
    throw new Error("Missing or invalid occurrence createdPageId");
  }
  if (typeof input.updates !== "object" || input.updates === null || Array.isArray(input.updates)) {
    throw new Error("Missing or invalid occurrence updates");
  }
};

export const live: Layer.Layer<
  never,
  never,
  | AutomationApplication
  | AutomationExecution
  | ConversationCommands
  | ElectronIpc
  | MainConfig
  | RendererClientRuntime
  | ScheduledAutomationRuntime
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const automation = yield* AutomationApplication;
    const execution = yield* AutomationExecution;
    const conversationCommands = yield* ConversationCommands;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const scheduledAutomations = yield* ScheduledAutomationRuntime;
    const windows = yield* WindowRuntime;
    const rendererClients = yield* RendererClientRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Automation", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Automation access requires an active Nodex window");
          }
          return rendererClients.ensureClient(event.sender).clientId;
        },
        catch: (cause) => new AutomationIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A, E>(operation: string, task: Effect.Effect<A, E>) =>
      task.pipe(Effect.mapError((cause) => new AutomationIpcError({ operation, cause })));
    const { handleControl, handlePlainCommand, handleQuery } = mapElectronIpcHandlers(
      ipc,
      (channel, handler) =>
        (event, ...args) =>
          authorize(event).pipe(Effect.andThen(run(channel, handler(event, ...args)))),
    );

    yield* handleQuery("calendar:occurrences", (_, projectId, start, end, query, after) =>
      automation.occurrences
        .list({ projectId, windowStart: start, windowEnd: end, searchQuery: query, after })
        .pipe(
          Effect.map((window) => ({
            occurrences: [...window.items],
            nextCursor: window.nextCursor,
          })),
        ),
    );
    yield* handlePlainCommand("page:occurrence:complete", (_, projectId, input) => {
      requireCompleteOccurrence(input);
      return automation.occurrences.complete(projectId, input);
    });
    yield* handlePlainCommand("page:occurrence:skip", (_, projectId, input) => {
      requireOccurrence(input);
      return automation.occurrences.skip(projectId, input);
    });
    yield* handlePlainCommand("page:occurrence:update", (_, projectId, input) => {
      requireUpdateOccurrence(input);
      return automation.occurrences.update(projectId, input);
    });

    const broadcastDefinitionChanged = (
      automationId: string,
      targetThreadId: string | null,
      reason: "upsert" | "delete",
    ) =>
      Effect.sync(() => {
        safeBroadcastToWindows(windows.all(), "codex:scheduled-automations:changed", [
          { automationId, targetThreadId, reason },
        ]);
      });
    const broadcastRunsUpdated = (event: CodexAutomationRunsUpdatedEvent) =>
      Effect.sync(() => {
        safeBroadcastToWindows(windows.all(), "codex:automation-runs:updated", [event]);
      });
    const broadcastRunChanged = (
      event: CodexAutomationRunsUpdatedEvent,
      refreshDefinition = true,
    ) =>
      broadcastRunsUpdated(event).pipe(
        Effect.andThen(
          refreshDefinition && event.automationId
            ? broadcastDefinitionChanged(event.automationId, null, "upsert")
            : Effect.void,
        ),
      );

    yield* handleQuery("codex:scheduled-automations:list", () =>
      automation.definitions.list().pipe(Effect.map((items) => ({ items: [...items] }))),
    );
    yield* handlePlainCommand("codex:scheduled-automations:create", (_, input) =>
      execution.prepareDefinition(input).pipe(
        Effect.flatMap(automation.definitions.create),
        Effect.tap((item) => broadcastDefinitionChanged(item.id, item.targetThreadId, "upsert")),
        Effect.map((item) => ({ item })),
      ),
    );
    yield* handlePlainCommand("codex:scheduled-automations:update", (_, input) =>
      automation.definitions.get(input.id).pipe(
        Effect.flatMap((current) => execution.prepareDefinition(input, current)),
        Effect.flatMap(automation.definitions.update),
        Effect.flatMap((item) =>
          item
            ? broadcastDefinitionChanged(item.id, item.targetThreadId, "upsert").pipe(
                Effect.as({ item }),
              )
            : Effect.fail(
                new AutomationIpcError({
                  operation: "codex:scheduled-automations:update",
                  cause: new Error("Scheduled automation update failed."),
                }),
              ),
        ),
      ),
    );
    yield* handlePlainCommand("codex:scheduled-automations:delete", (_, input) =>
      automation.definitions.delete(input.id).pipe(
        Effect.tap((result) =>
          result.success
            ? Effect.all(
                [
                  result.deletedRunCount > 0
                    ? broadcastRunsUpdated({
                        automationId: result.item?.id ?? input.id,
                        threadId: null,
                        reason: "delete",
                      })
                    : Effect.void,
                  broadcastDefinitionChanged(
                    result.item?.id ?? input.id,
                    result.item?.targetThreadId ?? null,
                    "delete",
                  ),
                ],
                { discard: true },
              )
            : Effect.void,
        ),
        Effect.map((result) => ({
          item: result.item,
          success: result.success,
          status: result.status,
        })),
      ),
    );
    yield* handlePlainCommand("codex:scheduled-automations:run-now", (event, input) =>
      execution
        .runNow(input, rendererClients.ensureClient(event.sender).clientId)
        .pipe(Effect.as({ success: true })),
    );
    yield* handleControl("codex:scheduled-automations:heartbeat-enabled-changed", (_, input) =>
      scheduledAutomations
        .setHeartbeatAutomationsEnabled(input.enabled)
        .pipe(Effect.as({ success: true })),
    );
    yield* handleControl(
      "codex:scheduled-automations:heartbeat-thread-state-changed",
      (event, input) =>
        scheduledAutomations
          .setHeartbeatThreadRendererState({
            ...input,
            rendererClientId: rendererClients.ensureClient(event.sender).clientId,
          })
          .pipe(Effect.as({ success: true })),
    );
    yield* handlePlainCommand("codex:automation-runs:archive", (_, input) =>
      Effect.all({
        run: automation.runs.get(input.threadId),
        messages:
          input.archivedAssistantMessage != null || input.archivedUserMessage != null
            ? Effect.succeed({
                archivedAssistantMessage: input.archivedAssistantMessage ?? null,
                archivedUserMessage: input.archivedUserMessage ?? null,
              })
            : execution.resolveArchiveMessages(input.threadId),
      }).pipe(
        Effect.flatMap(({ run: item, messages }) =>
          automation.runs.archive({ ...input, ...messages }).pipe(
            Effect.tap((success) =>
              item && success
                ? broadcastRunChanged({
                    automationId: item.automationId,
                    threadId: input.threadId,
                    reason: "archive",
                  })
                : Effect.void,
            ),
            Effect.map((success) => ({ success })),
          ),
        ),
      ),
    );
    yield* handlePlainCommand("codex:automation-runs:delete", (_, input) =>
      automation.runs.get(input.threadId).pipe(
        Effect.flatMap((item) =>
          automation.runs.delete(input.threadId).pipe(
            Effect.tap((success) =>
              success && item
                ? broadcastRunChanged({
                    automationId: item.automationId,
                    threadId: input.threadId,
                    reason: "delete",
                  })
                : Effect.void,
            ),
            Effect.map((success) => ({ success })),
          ),
        ),
      ),
    );
    yield* handlePlainCommand("codex:automation-runs:unarchive", (_, input) =>
      automation.runs.get(input.threadId).pipe(
        Effect.flatMap((item) =>
          conversationCommands.unarchive(input.threadId).pipe(
            Effect.andThen(automation.runs.unarchive(input.threadId)),
            Effect.tap((success) =>
              success && item
                ? broadcastRunChanged({
                    automationId: item.automationId,
                    threadId: input.threadId,
                    reason: "unarchive",
                  })
                : Effect.void,
            ),
            Effect.map((success) => ({ success })),
          ),
        ),
      ),
    );
    yield* handleQuery("codex:automation-runs:inbox-items", (_, limit) =>
      automation.inbox.read(limit ?? 200),
    );
    yield* handlePlainCommand("codex:automation-runs:set-read-state", (_, input) =>
      automation.inbox.setReadState(input).pipe(
        Effect.tap((item) =>
          item
            ? broadcastRunChanged({
                automationId: item.automationId,
                threadId: input.threadId,
                reason: "read-state",
              })
            : Effect.void,
        ),
      ),
    );
    yield* handlePlainCommand("codex:automation-runs:mark-all-read", () =>
      automation.inbox.markAllRead.pipe(
        Effect.tap((changedCount) =>
          changedCount > 0
            ? broadcastRunsUpdated({
                automationId: null,
                threadId: null,
                reason: "mark-all-read",
              })
            : Effect.void,
        ),
        Effect.map((changedCount) => ({ changedCount })),
      ),
    );
  }),
);
