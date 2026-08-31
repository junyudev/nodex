import { isAbsolute } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { IpcMainInvokeEvent } from "electron";
import type { McpResourceReadParams } from "@nodex/codex-app-server-protocol/v2/McpResourceReadParams";
import type { McpServerToolCallParams } from "@nodex/codex-app-server-protocol/v2/McpServerToolCallParams";
import type { CodexErrorInfo } from "@nodex/codex-app-server-protocol/v2/CodexErrorInfo";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type {
  CodexComposerPluginActivateInput,
  CodexComposerPluginListInput,
  CodexComposerSkillListInput,
  CodexConversationImageAssetResolveInput,
  CodexPersonality,
  CodexRateLimitResetInput,
  CodexThreadGoalDraftInput,
} from "../../../shared/types";
import type {
  CreatePastedTextAttachmentInput,
  ReadPastedTextAttachmentInput,
  RemovePastedTextAttachmentInput,
} from "../../../shared/pasted-text-attachments";
import type { FeedbackUploadParams } from "@nodex/codex-app-server-protocol/v2/FeedbackUploadParams";
import type { ThreadBackgroundTerminal } from "@nodex/codex-app-server-protocol/v2/ThreadBackgroundTerminal";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import type { ReviewStartParams } from "@nodex/codex-app-server-protocol/v2/ReviewStartParams";
import type { ReviewStartResponse } from "@nodex/codex-app-server-protocol/v2/ReviewStartResponse";
import type { TurnError } from "@nodex/codex-app-server-protocol/v2/TurnError";
import type { IpcEvents } from "../../../shared/ipc-api";
import type { CodexHooksListInput, CodexHooksStateUpdateInput } from "../../../shared/codex-hooks";
import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import { parseCodexProtocolThreadItem } from "../../../shared/codex-protocol-thread-item";

type ReviewStartCodexErrorInfo = NonNullable<
  NonNullable<ClientRequestResponsesByMethod["review/start"]["turn"]["error"]>["codexErrorInfo"]
>;
type ReviewStartTurnError = NonNullable<
  ClientRequestResponsesByMethod["review/start"]["turn"]["error"]
>;
type ReviewStartMisalignment = NonNullable<ReviewStartTurnError["misalignment"]>;

function normalizeReviewCodexErrorInfo(
  value: ReviewStartCodexErrorInfo | null | undefined,
): CodexErrorInfo | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if ("httpConnectionFailed" in value) {
    return {
      httpConnectionFailed: {
        httpStatusCode: value.httpConnectionFailed.httpStatusCode ?? null,
      },
    };
  }
  if ("responseStreamConnectionFailed" in value) {
    return {
      responseStreamConnectionFailed: {
        httpStatusCode: value.responseStreamConnectionFailed.httpStatusCode ?? null,
      },
    };
  }
  if ("responseStreamDisconnected" in value) {
    return {
      responseStreamDisconnected: {
        httpStatusCode: value.responseStreamDisconnected.httpStatusCode ?? null,
      },
    };
  }
  if ("responseTooManyFailedAttempts" in value) {
    return {
      responseTooManyFailedAttempts: {
        httpStatusCode: value.responseTooManyFailedAttempts.httpStatusCode ?? null,
      },
    };
  }
  return value;
}

function normalizeReviewMisalignment(
  value: ReviewStartMisalignment | null | undefined,
): TurnError["misalignment"] {
  if (value === null || value === undefined) return null;
  return {
    errorType: value.errorType ?? null,
    detailedExplanation: value.detailedExplanation ?? null,
    steer: value.steer ?? null,
  };
}

function normalizeReviewTurnError(
  value: ReviewStartTurnError | null | undefined,
): TurnError | null {
  if (value === null || value === undefined) return null;
  return {
    message: value.message,
    codexErrorInfo: normalizeReviewCodexErrorInfo(value.codexErrorInfo),
    additionalDetails: value.additionalDetails ?? null,
    misalignment: normalizeReviewMisalignment(value.misalignment),
  };
}

function normalizeReviewStartResponse(
  response: ClientRequestResponsesByMethod["review/start"],
): ReviewStartResponse {
  return {
    reviewThreadId: response.reviewThreadId,
    turn: {
      id: response.turn.id,
      itemsView: response.turn.itemsView ?? "full",
      status: response.turn.status,
      error: normalizeReviewTurnError(response.turn.error),
      startedAt: response.turn.startedAt ?? null,
      completedAt: response.turn.completedAt ?? null,
      durationMs: response.turn.durationMs ?? null,
      items: response.turn.items.map((item) => {
        const normalized =
          item.type === "userMessage" ? { ...item, clientId: item.clientId ?? null } : item;
        const parsed = parseCodexProtocolThreadItem(normalized);
        if (!parsed) throw new Error(`Invalid review item '${item.type}'`);
        return parsed;
      }),
    },
  };
}
import { CodexAccount, type CodexAccountLoginInput } from "../../codex-application/CodexAccount";
import { CodexConnection } from "../../codex-application/CodexConnection";
import { CodexMedia } from "../../codex-application/CodexMedia";
import { CodexToolRuntime } from "../../codex-application/CodexToolRuntime";
import { ComposerCatalog } from "../../codex-application/ComposerCatalog";
import { ComposerExternalSuggestions } from "../../codex-application/ComposerExternalSuggestions";
import { ConversationCommands } from "../../codex-application/ConversationCommands";
import { CodexPreferences } from "../../codex-application/CodexPreferences";
import { CodexAttachments } from "../../codex-application/CodexAttachments";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { MainConfig } from "../../app/MainConfig";

export class CodexApplicationIpcError extends Schema.TaggedError<CodexApplicationIpcError>()(
  "CodexApplicationIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const validate = <A>(
  operation: string,
  parse: () => A,
): Effect.Effect<A, CodexApplicationIpcError> =>
  Effect.try({
    try: parse,
    catch: (cause) => new CodexApplicationIpcError({ operation, cause }),
  });

const parseComposerInventoryCwds = (
  input: CodexComposerPluginListInput | CodexComposerSkillListInput,
): string[] => {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray(input.cwds) ||
    input.cwds.length > 32 ||
    input.cwds.some(
      (cwd) =>
        typeof cwd !== "string" ||
        cwd.length > 4_096 ||
        (cwd.trim().length > 0 && !isAbsolute(cwd.trim())),
    )
  ) {
    throw new Error("Invalid composer inventory input");
  }
  return input.cwds;
};

const parseComposerPluginActivation = (
  input: CodexComposerPluginActivateInput,
): CodexComposerPluginActivateInput => {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.id !== "string" ||
    input.id.trim().length === 0 ||
    input.id.length > 512
  ) {
    throw new Error("Invalid composer plugin activation input");
  }
  return { id: input.id.trim(), cwds: parseComposerInventoryCwds(input) };
};

const parseFeedbackUpload = (input: FeedbackUploadParams) => ({
  classification: input.classification,
  ...(input.reason === undefined ? {} : { reason: input.reason }),
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.includeLogs === undefined ? {} : { includeLogs: input.includeLogs }),
  ...(input.extraLogFiles === undefined ? {} : { extraLogFiles: input.extraLogFiles }),
  ...(input.tags === undefined
    ? {}
    : {
        tags:
          input.tags === null
            ? null
            : Object.fromEntries(
                Object.entries(input.tags).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              ),
      }),
});

export const live: Layer.Layer<
  never,
  never,
  | ElectronIpc
  | ElectronWindowHost
  | MainConfig
  | CodexAccount
  | CodexConnection
  | CodexMedia
  | ComposerCatalog
  | ComposerExternalSuggestions
  | ConversationCommands
  | CodexPreferences
  | CodexAttachments
  | CodexToolRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const windows = yield* ElectronWindowHost;
    const config = yield* MainConfig;
    const account = yield* CodexAccount;
    const connection = yield* CodexConnection;
    const media = yield* CodexMedia;
    const composer = yield* ComposerCatalog;
    const externalSuggestions = yield* ComposerExternalSuggestions;
    const conversations = yield* ConversationCommands;
    const preferences = yield* CodexPreferences;
    const attachments = yield* CodexAttachments;
    const tools = yield* CodexToolRuntime;
    const trusted = (event: IpcMainInvokeEvent, capabilityName: string) =>
      validate("authorize-renderer", () =>
        requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl),
      );

    yield* SubscriptionRef.changes(account.snapshot).pipe(
      Stream.runForEach((snapshot) =>
        windows.all.pipe(
          Effect.tap((all) =>
            Effect.sync(() => {
              const rateLimits = snapshot.rateLimits ?? null;
              safeBroadcastToWindows(all, "codex:event" satisfies keyof IpcEvents, [
                { type: "rateLimits", rateLimits },
              ]);
              safeBroadcastToWindows(all, "codex:host-message" satisfies keyof IpcEvents, [
                {
                  type: "sharedObjectUpdated",
                  hostId: DEFAULT_CODEX_HOST_ID,
                  object: { objectType: "rateLimits", objectId: "rateLimits", value: rateLimits },
                },
              ]);
              safeBroadcastToWindows(all, "codex:event" satisfies keyof IpcEvents, [
                { type: "account", account: snapshot },
              ]);
              safeBroadcastToWindows(all, "codex:host-message" satisfies keyof IpcEvents, [
                {
                  type: "sharedObjectUpdated",
                  hostId: DEFAULT_CODEX_HOST_ID,
                  object: { objectType: "account", objectId: "account", value: snapshot },
                },
              ]);
            }),
          ),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped,
    );

    yield* ipc.handleQuery("codex:account:read", () => account.refresh);
    yield* ipc.handlePlainCommand(
      "codex:account:rate-limit-reset:consume",
      (_event, input: CodexRateLimitResetInput) => account.consumeRateLimitResetCredit(input),
    );
    yield* ipc.handlePlainCommand(
      "codex:account:login:start",
      (_event, input: CodexAccountLoginInput) => account.startLogin(input),
    );
    yield* ipc.handlePlainCommand("codex:account:login:cancel", (_event, loginId: string) =>
      account.cancelLogin(loginId),
    );
    yield* ipc.handlePlainCommand("codex:account:logout", () => account.logout);
    yield* ipc.handleQuery("codex:connection:status", () => connection.read);
    yield* ipc.handleQuery("codex:personality:get", () => Effect.sync(() => preferences.current()));
    yield* ipc.handlePlainCommand(
      "codex:personality:set",
      (_event, personality: CodexPersonality) => preferences.setPersonality(personality),
    );
    yield* ipc.handlePlainCommand(
      "codex:thread:goal:materialize-draft",
      (_event, draft: CodexThreadGoalDraftInput) => attachments.materializeGoal(draft),
    );
    yield* ipc.handleControl(
      "codex:thread:goal:materialized-cleanup",
      (_event, attachmentDirectory: string | null) =>
        attachments.cleanupMaterializedGoal(attachmentDirectory),
    );
    yield* ipc.handleQuery(
      "codex:thread:goal:editable-objective:read",
      (_event, objective: string) => attachments.readEditableObjective(objective),
    );
    yield* ipc.handlePlainCommand(
      "codex:pasted-text:create",
      (_event, input: CreatePastedTextAttachmentInput) => attachments.createPastedText(input),
    );
    yield* ipc.handleQuery(
      "codex:pasted-text:read",
      (_event, input: ReadPastedTextAttachmentInput) => attachments.readPastedText(input.file),
    );
    yield* ipc.handlePlainCommand(
      "codex:pasted-text:remove",
      (_event, input: RemovePastedTextAttachmentInput) => attachments.removePastedText(input.file),
    );
    yield* ipc.handlePlainCommand(
      "codex:thread:memory-mode:set",
      (_event, threadId: string, mode: ThreadMemoryMode) =>
        conversations.setMemoryMode(threadId, mode),
    );
    yield* ipc.handlePlainCommand("codex:review:start", (_event, params: ReviewStartParams) =>
      conversations.startReview(params).pipe(
        Effect.flatMap((response) =>
          Effect.try({
            try: () => normalizeReviewStartResponse(response),
            catch: (cause) =>
              new CodexApplicationIpcError({ operation: "normalize-review-response", cause }),
          }),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("codex:feedback:upload", (_event, params: FeedbackUploadParams) =>
      conversations.uploadFeedback(parseFeedbackUpload(params)),
    );
    yield* ipc.handlePlainCommand(
      "codex:turn:interrupt",
      (_event, threadId: string, turnId?: string) =>
        conversations.interrupt(threadId.trim(), turnId),
    );
    yield* ipc.handlePlainCommand(
      "codex:thread:background-terminals:clean",
      (_event, threadId: string) => {
        const normalized = threadId.trim();
        return normalized
          ? conversations.cleanBackgroundTerminals(normalized)
          : Effect.succeed(false);
      },
    );
    yield* ipc.handlePlainCommand(
      "codex:thread:background-terminals:clean-silent",
      (_event, threadId: string) => {
        const normalized = threadId.trim();
        return normalized
          ? conversations.cleanBackgroundTerminalsSilently(normalized)
          : Effect.succeed(false);
      },
    );
    yield* ipc.handleQuery("codex:thread:background-terminals:list", (_event, threadId: string) => {
      const normalized = threadId.trim();
      return normalized
        ? conversations.listBackgroundTerminals(normalized).pipe(
            Effect.map((items) =>
              items.map((item): ThreadBackgroundTerminal => ({
                itemId: item.itemId,
                processId: item.processId,
                command: item.command,
                cwd: item.cwd,
                osPid: item.osPid ?? null,
                cpuPercent: item.cpuPercent ?? null,
                rssKb: item.rssKb == null ? null : BigInt(Math.trunc(item.rssKb)),
              })),
            ),
          )
        : Effect.succeed<ThreadBackgroundTerminal[]>([]);
    });
    yield* ipc.handlePlainCommand(
      "codex:thread:background-terminals:terminate",
      (_event, input: { readonly threadId: string; readonly processId: string }) => {
        const threadId = input.threadId.trim();
        const processId = input.processId.trim();
        return threadId && processId
          ? conversations.terminateBackgroundTerminal(threadId, processId)
          : Effect.succeed(false);
      },
    );
    yield* ipc.handleQuery(
      "codex:conversation-image-asset:resolve",
      (_event, input: CodexConversationImageAssetResolveInput) => media.resolveImage(input),
    );

    yield* ipc.handleQuery("codex:model:list", () => composer.listModels);
    yield* ipc.handleQuery("codex:collaboration-mode:list", () => composer.listCollaborationModes);
    yield* ipc.handleQuery("codex:experimental-features:list", (event) =>
      trusted(event, "Experimental feature access").pipe(
        Effect.andThen(composer.listExperimentalFeatures),
      ),
    );
    yield* ipc.handleQuery(
      "codex:composer-plugins:list",
      (_event, input: CodexComposerPluginListInput) =>
        validate("composer-plugins-list", () => parseComposerInventoryCwds(input)).pipe(
          Effect.flatMap(composer.listPlugins),
        ),
    );
    yield* ipc.handlePlainCommand(
      "codex:composer-plugins:activate",
      (_event, input: CodexComposerPluginActivateInput) =>
        validate("composer-plugin-activate", () => parseComposerPluginActivation(input)).pipe(
          Effect.flatMap(composer.activatePlugin),
        ),
    );
    yield* ipc.handleQuery(
      "codex:composer-skills:list",
      (_event, input: CodexComposerSkillListInput) =>
        validate("composer-skills-list", () => parseComposerInventoryCwds(input)).pipe(
          Effect.flatMap(composer.listSkills),
        ),
    );
    yield* ipc.handleQuery("codex:hooks:list", (_event, input: CodexHooksListInput) =>
      composer.listHooks(input),
    );
    yield* ipc.handlePlainCommand(
      "codex:hooks:state:update",
      (_event, input: CodexHooksStateUpdateInput) =>
        composer.updateHooksState(input).pipe(
          Effect.andThen(
            windows.all.pipe(
              Effect.tap((all) =>
                Effect.sync(() => {
                  safeBroadcastToWindows(all, "codex:hooks:changed" satisfies keyof IpcEvents, [
                    { hostId: input.hostId },
                  ]);
                }),
              ),
              Effect.asVoid,
            ),
          ),
        ),
    );
    yield* ipc.handleQuery("codex:composer-sites:list", () => externalSuggestions.listSites);
    yield* ipc.handleQuery("codex:composer-chatgpt-conversations:list", (_event, input: unknown) =>
      validate("composer-chatgpt-conversations-list", () => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("query" in input) ||
          typeof input.query !== "string" ||
          input.query.length > 1_000
        ) {
          throw new Error("Invalid composer ChatGPT conversation query");
        }
        return input.query.trim();
      }).pipe(Effect.flatMap(externalSuggestions.listChatGptConversations)),
    );

    yield* ipc.handleQuery("codex:mcp-resource:read", (event, params: McpResourceReadParams) =>
      trusted(event, "MCP resource access").pipe(Effect.andThen(tools.readResource(params))),
    );
    yield* ipc.handlePlainCommand("codex:mcp-tool:call", (event, params: McpServerToolCallParams) =>
      trusted(event, "MCP tool access").pipe(Effect.andThen(tools.callTool(params))),
    );
    yield* ipc.handleQuery("codex:mcp-apps:list", (event) =>
      trusted(event, "MCP app access").pipe(Effect.andThen(tools.listApps)),
    );
    yield* ipc.handleQuery("codex:mcp-server-statuses:list", (event, threadId?: string) =>
      trusted(event, "MCP server status access").pipe(
        Effect.andThen(tools.listServerStatuses(threadId?.trim() || undefined)),
      ),
    );
  }),
);
