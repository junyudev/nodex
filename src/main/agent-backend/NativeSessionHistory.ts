import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { MainConfig } from "../app/MainConfig";
import { ClaudeSdk } from "../platform/node/ClaudeSdk";
import {
  OpenCodeSdk,
  type OpenCodeConnection,
  type OpenCodeNativeMessage,
} from "../platform/node/OpenCodeSdk";
import { NativePromptImages } from "./NativePromptImages";
import {
  emptyAgentConversationSnapshot,
  applyAgentHistoryFacts,
} from "./AgentConversationProjection";
import { projectClaudeHistory } from "./claude/ClaudeConversationProjection";
import { projectOpenCodeHistory } from "./opencode/OpenCodeConversationProjection";
import { nativeHistoryFacts } from "./NativeSessionState";
import { boundAgentToolOutput } from "../../shared/agent-tool-output";
import type {
  AgentConversationSnapshot,
  AgentCanonicalSessionUpdate,
} from "../../shared/agent-conversation";
import type {
  AgentBackendHistoryReadInput,
  AgentBackendHistoryImageInput,
  AgentBackendToolOutputInput,
  AgentNativeHistoryInspection,
} from "../../shared/agent-backend-api";

const MAX_NATIVE_PAGE_RECORDS = 2048;
const MAX_HISTORY_REPLY_BYTES = 1024 * 1024;
const preview = (text: string): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= 8192) return text;
  let end = 8189;
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
};
type ToolUpdate = Extract<AgentCanonicalSessionUpdate, { readonly kind: "tool-call" }>;
const previewToolUpdate = (update: ToolUpdate): ToolUpdate => ({
  ...update,
  detail: preview(update.detail),
  ...(update.input === undefined ? {} : { input: preview(update.input) }),
  ...(typeof update.output === "string"
    ? { output: preview(update.output) }
    : { output: undefined }),
  truncated:
    update.truncated ||
    Buffer.byteLength(update.detail) > 8192 ||
    (update.input !== undefined && Buffer.byteLength(update.input) > 8192) ||
    (typeof update.output === "string"
      ? Buffer.byteLength(update.output) > 8192
      : update.output !== undefined),
});
const previewUpdate = (update: AgentCanonicalSessionUpdate): AgentCanonicalSessionUpdate => {
  if (update.kind === "message")
    return {
      ...update,
      text: preview(update.text),
      truncated: update.truncated || Buffer.byteLength(update.text) > 8192,
    };
  if (update.kind === "tool-call") return previewToolUpdate(update);
  return update;
};
const boundHistoryReply = (snapshot: AgentConversationSnapshot): AgentConversationSnapshot => ({
  ...snapshot,
  turns: snapshot.turns.map((turn) => ({
    ...turn,
    promptText: turn.promptText === null ? null : preview(turn.promptText),
    updates: turn.updates.map(previewUpdate),
  })),
  ...(snapshot.toolCalls
    ? {
        toolCalls: snapshot.toolCalls.map((entry) => ({
          ...entry,
          update: previewToolUpdate(entry.update),
        })),
      }
    : {}),
});
const isExactOpenCodeMessage = (message: OpenCodeNativeMessage, sessionId: string): boolean =>
  message.info.sessionID === sessionId &&
  message.parts.every((part) => part.sessionID === sessionId && part.messageID === message.info.id);

/** Reads an imported native descriptor without opening a product execution owner. */
export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const settings = yield* ApplicationSettings;
  const config = yield* MainConfig;
  const claude = yield* ClaudeSdk;
  const opencode = yield* OpenCodeSdk;
  const images = yield* NativePromptImages;
  const descriptor = Effect.fn("NativeSessionHistory.descriptor")(function* (threadId: string) {
    const thread = yield* workspace.getThread(threadId);
    const session = yield* workspace.readThreadBackendSession(threadId);
    if (
      !thread ||
      !session ||
      (session.backendBinding.kind !== "claude" && session.backendBinding.kind !== "opencode") ||
      !isDeepStrictEqual(thread.backendBinding, session.backendBinding) ||
      !thread.cwd
    )
      return yield* Effect.fail(new Error("The native history descriptor is unavailable"));
    return { thread, session, settingsRevision: (yield* settings.snapshot()).revision };
  });
  const assertCurrent = Effect.fn("NativeSessionHistory.assertCurrent")(function* (
    source: Effect.Success<ReturnType<typeof descriptor>>,
  ) {
    const current = yield* descriptor(source.thread.threadId);
    if (
      !isDeepStrictEqual(current.session, source.session) ||
      current.thread.cwd !== source.thread.cwd ||
      current.settingsRevision !== source.settingsRevision
    )
      return yield* Effect.fail(new Error("The native history source changed"));
  });
  const claudeInput = Effect.fn("NativeSessionHistory.claudeInput")(function* (
    source: Effect.Success<ReturnType<typeof descriptor>>,
  ) {
    const binding = source.session.backendBinding;
    if (binding.kind !== "claude")
      return yield* Effect.fail(new Error("This history is not Claude"));
    const launch = yield* settings.claudeLaunchConfiguration(binding.instanceConfigId);
    const input = {
      instance: launch.instance,
      environment: { ...config.environment, ...launch.environment },
      cwd: source.thread.cwd!,
      sessionId: source.session.backendSessionId,
    };
    const home = yield* claude.nativeHome(input);
    if (source.session.nativeHome && home !== source.session.nativeHome)
      return yield* Effect.fail(new Error("The Claude history profile changed"));
    return { input, home };
  });
  const withOpenCode = <A, E>(
    source: Effect.Success<ReturnType<typeof descriptor>>,
    read: (connection: OpenCodeConnection) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = source.session.backendBinding;
        if (binding.kind !== "opencode")
          return yield* Effect.fail(new Error("This history is not OpenCode"));
        const launch = yield* settings.openCodeLaunchConfiguration(binding.instanceConfigId);
        const nativeHome = launch.instance.serverUrl ?? launch.profileDirectory;
        if (source.session.nativeHome && nativeHome !== source.session.nativeHome)
          return yield* Effect.fail(new Error("The OpenCode history profile changed"));
        const connection = yield* opencode.open({
          binaryPath: launch.instance.binaryPath,
          serverUrl: launch.instance.serverUrl,
          profileDirectory: launch.profileDirectory,
          cwd: source.thread.cwd!,
          environment: { ...config.environment, ...launch.environment },
          ...(launch.environment.OPENCODE_SERVER_PASSWORD
            ? { serverPassword: launch.environment.OPENCODE_SERVER_PASSWORD }
            : {}),
          ...(launch.environment.OPENCODE_SERVER_USERNAME
            ? { serverUsername: launch.environment.OPENCODE_SERVER_USERNAME }
            : {}),
        });
        return yield* read(connection);
      }),
    );
  return {
    read: Effect.fn("NativeSessionHistory.read")(function* (input: AgentBackendHistoryReadInput) {
      const source = yield* descriptor(input.threadId);
      const limit = input.limit ?? 50;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (input.before !== undefined && (input.before.length === 0 || input.before.length > 8192))
      )
        return yield* Effect.fail(new Error("Native history page is invalid"));
      const empty = emptyAgentConversationSnapshot({
        backend: source.session.backendBinding.kind,
        threadId: input.threadId,
        sessionId: source.session.backendSessionId,
      });
      let snapshot;
      let before: string | null;
      let hasMore: boolean;
      if (source.session.backendBinding.kind === "claude") {
        const { input: native, home } = yield* claudeInput(source);
        const page = yield* claude.historyPage(native, {
          limit,
          ...(input.before ? { before: input.before } : {}),
        });
        if (
          page.messages.length > MAX_NATIVE_PAGE_RECORDS ||
          page.messages.some((message) => message.session_id !== source.session.backendSessionId)
        )
          return yield* Effect.fail(new Error("Native history page exceeded its bound"));
        if ((yield* claude.nativeHome(native)) !== home)
          return yield* Effect.fail(new Error("The Claude history profile changed"));
        snapshot = projectClaudeHistory(empty, page.messages);
        before = page.before;
        hasMore = page.hasMore;
      } else {
        const page = yield* withOpenCode(source, (connection) =>
          Effect.gen(function* () {
            const page = yield* connection.history(source.session.backendSessionId, {
              limit,
              ...(input.before ? { before: input.before } : {}),
            });
            if (
              page.messages.length > limit ||
              page.messages.some(
                (message) => !isExactOpenCodeMessage(message, source.session.backendSessionId),
              )
            )
              return yield* Effect.fail(new Error("The native history page is invalid"));
            const present = new Set(page.messages.map((message) => message.info.id));
            const missing = new Set(
              page.messages.flatMap((message) =>
                message.info.role === "assistant" && !present.has(message.info.parentID)
                  ? [message.info.parentID]
                  : [],
              ),
            );
            const parents = yield* Effect.forEach(
              missing,
              (messageId) =>
                connection
                  .message(source.session.backendSessionId, messageId)
                  .pipe(
                    Effect.flatMap((message) =>
                      message.info.id === messageId &&
                      message.info.role === "user" &&
                      isExactOpenCodeMessage(message, source.session.backendSessionId)
                        ? Effect.succeed(message)
                        : Effect.fail(new Error("The native history parent changed")),
                    ),
                  ),
              { concurrency: 4 },
            );
            return { ...page, messages: [...parents, ...page.messages] };
          }),
        );
        snapshot = projectOpenCodeHistory(empty, page.messages);
        before = page.cursor;
        hasMore = page.hasMore;
      }
      yield* assertCurrent(source);
      const reply = boundHistoryReply({
        ...applyAgentHistoryFacts(snapshot, nativeHistoryFacts(source.session.nativeState)),
        status: "closed" as const,
        history: {
          hasOlder: hasMore,
          oldestSequence: snapshot.turns[0]?.sequence ?? null,
          ...(before ? { cursor: before } : {}),
          windowSize: limit,
        },
      });
      if (Buffer.byteLength(JSON.stringify(reply), "utf8") > MAX_HISTORY_REPLY_BYTES)
        return yield* Effect.fail(new Error("The native history page exceeded its byte bound"));
      return reply;
    }),
    image: Effect.fn("NativeSessionHistory.image")(function* (
      input: AgentBackendHistoryImageInput,
    ) {
      const source = yield* descriptor(input.threadId);
      if (source.session.backendSessionId !== input.expectedSessionId)
        return yield* Effect.fail(new Error("The native image source changed"));
      const image =
        source.session.backendBinding.kind === "claude"
          ? yield* claudeInput(source).pipe(
              Effect.flatMap(({ input: native }) =>
                claude.historyImage(native, input.nativeMessageId, input.index),
              ),
            )
          : yield* withOpenCode(source, (connection) =>
              Effect.gen(function* () {
                const message = yield* connection.message(
                  source.session.backendSessionId,
                  input.nativeMessageId,
                );
                if (
                  message.info.sessionID !== source.session.backendSessionId ||
                  message.info.id !== input.nativeMessageId
                )
                  return yield* Effect.fail(new Error("The native image source changed"));
                const part = message.parts.filter(
                  (value) => value.type === "file" && value.mime.startsWith("image/"),
                )[input.index];
                if (!part || part.type !== "file")
                  return yield* Effect.fail(new Error("The native image is unavailable"));
                const match =
                  /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(
                    part.url,
                  );
                if (!match)
                  return yield* Effect.fail(new Error("The native image is not embedded"));
                return {
                  mediaType: match[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                  data: match[2]!,
                };
              }),
            );
      yield* assertCurrent(source);
      return yield* images.materialize(image);
    }),
    toolOutput: Effect.fn("NativeSessionHistory.toolOutput")(function* (
      input: AgentBackendToolOutputInput,
    ) {
      const source = yield* descriptor(input.threadId);
      if (source.session.backendSessionId !== input.expectedSessionId)
        return yield* Effect.fail(new Error("The native tool output source changed"));
      const output =
        source.session.backendBinding.kind === "claude"
          ? yield* claudeInput(source).pipe(
              Effect.flatMap(({ input: native }) =>
                claude.historyToolOutput(native, input.nativeMessageId, input.toolUseId),
              ),
            )
          : yield* withOpenCode(source, (connection) =>
              Effect.gen(function* () {
                const message = yield* connection.message(
                  source.session.backendSessionId,
                  input.nativeMessageId,
                );
                if (
                  message.info.sessionID !== source.session.backendSessionId ||
                  message.info.id !== input.nativeMessageId
                )
                  return yield* Effect.fail(new Error("The native tool output source changed"));
                const part = message.parts.find(
                  (value) => value.type === "tool" && value.callID === input.toolUseId,
                );
                if (!part || part.type !== "tool")
                  return yield* Effect.fail(new Error("The native tool output is unavailable"));
                return boundAgentToolOutput(
                  part.state.status === "completed"
                    ? part.state.output
                    : part.state.status === "error"
                      ? part.state.error
                      : "",
                );
              }),
            );
      yield* assertCurrent(source);
      return output;
    }),
    inspect: Effect.fn("NativeSessionHistory.inspect")(function* (
      threadId: string,
    ): Effect.fn.Return<AgentNativeHistoryInspection, unknown> {
      const source = yield* descriptor(threadId);
      return {
        backendBinding: source.session.backendBinding,
        nativeSessionId: source.session.backendSessionId,
        nativeHome: source.session.nativeHome ?? null,
        cwd: source.thread.cwd,
      };
    }),
  };
});
