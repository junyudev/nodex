import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import * as AcpRpcs from "./rpc.ts";
import * as AcpSchema from "./compat.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpSchemaV2 from "./_generated/schema.gen.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";
import {
  callRpc,
  decodeExtNotificationRegistration,
  decodeExtRequestRegistration,
  isolateNotificationHandler,
  runHandler,
  withoutMalformedItems,
} from "./_internal/shared.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

const decodeElicitationRequestShape = Schema.decodeUnknownEffect(
  Schema.Union([AcpSchemaV2.CreateElicitationRequest, AcpSchemaV1.CreateElicitationRequest]),
);
// v1 admits a null JSON-RPC id, which cannot name the request an elicitation is scoped to.
const decodeElicitationRequest = (payload: unknown) =>
  decodeElicitationRequestShape(payload).pipe(
    Effect.mapError((cause) =>
      AcpError.AcpRequestError.invalidExtensionPayload(CLIENT_METHODS.elicitation_create, cause),
    ),
    Effect.flatMap((request) =>
      "requestId" in request && request.requestId === null
        ? Effect.fail(AcpError.AcpRequestError.invalidParams())
        : Effect.succeed(request as AcpSchema.CreateElicitationRequest),
    ),
  );

export interface AcpClientOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onIncomingRequest?: AcpProtocol.AcpPatchedProtocolOptions["onIncomingRequest"];
  readonly onTermination?: AcpProtocol.AcpPatchedProtocolOptions["onTermination"];
  readonly onOutgoingResponseFailure?: AcpProtocol.AcpPatchedProtocolOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: AcpProtocol.AcpPatchedProtocolOptions["onOutgoingResponse"];
  /** Transforms child output before protocol logging and parsing. */
  readonly transformStdout?: (
    stdout: ChildProcessSpawner.ChildProcessHandle["stdout"],
  ) => AcpProtocol.AcpStdio["stdin"];
  /** Transforms decoded session updates before buffering or delivery. */
  readonly transformSessionUpdate?: (
    notification: AcpSchema.SessionNotification,
  ) => AcpSchema.SessionNotification;
}

type AcpClientRaw = {
  readonly notifications: Stream.Stream<AcpProtocol.AcpIncomingNotification, AcpError.AcpError>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
};

export type AcpRequestHandler<Request, Response> = AcpProtocol.AcpRequestHandler<Request, Response>;

export class AcpClient extends Context.Service<
  AcpClient,
  {
    readonly raw: AcpClientRaw;
    /** Wire generation determined from the initialize response shape, not its version number. */
    readonly protocolGeneration: Effect.Effect<1 | 2 | undefined>;
    readonly agent: {
      /**
       * Initializes the ACP session and negotiates capabilities.
       * @see https://agentclientprotocol.com/protocol/schema#initialize
       */
      readonly initialize: (
        payload: AcpSchema.InitializeRequest,
      ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>;
      /**
       * Performs authentication with the method negotiated for ACP v1 or v2.
       * @see https://agentclientprotocol.com/protocol/v2/draft/authentication
       */
      readonly authenticate: (
        payload: AcpSchema.AuthenticateRequest,
      ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>;
      /**
       * Logs out the current ACP identity using the negotiated generation.
       * @see https://agentclientprotocol.com/protocol/v2/draft/authentication
       */
      readonly logout: (
        payload: AcpSchema.LogoutRequest,
      ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>;
      /**
       * Starts a new ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/new
       */
      readonly createSession: (
        payload: AcpSchema.NewSessionRequest,
      ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>;
      /**
       * Resumes a saved ACP session with replay from the beginning.
       *
       * This compatibility name maps to ACP v2's `session/resume`; v2 removed
       * `session/load` and expresses replay with `replayFrom`.
       */
      readonly loadSession: (
        payload: AcpSchema.LoadSessionRequest,
      ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>;
      /**
       * Lists available ACP sessions.
       * @see https://agentclientprotocol.com/protocol/schema#session/list
       */
      readonly listSessions: (
        payload: AcpSchema.ListSessionsRequest,
      ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>;
      /**
       * Forks an ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/fork
       */
      readonly forkSession: (
        payload: AcpSchema.ForkSessionRequest,
      ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>;
      /**
       * Resumes an ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/resume
       */
      readonly resumeSession: (
        payload: AcpSchema.ResumeSessionRequest,
      ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>;
      /**
       * Closes an ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/close
       */
      readonly closeSession: (
        payload: AcpSchema.CloseSessionRequest,
      ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>;
      readonly deleteSession: (
        payload: AcpSchema.DeleteSessionRequest,
      ) => Effect.Effect<AcpSchema.DeleteSessionResponse, AcpError.AcpError>;
      readonly listProviders: (
        payload: AcpSchema.ListProvidersRequest,
      ) => Effect.Effect<AcpSchema.ListProvidersResponse, AcpError.AcpError>;
      readonly setProvider: (
        payload: AcpSchema.SetProviderRequest,
      ) => Effect.Effect<AcpSchema.SetProviderResponse, AcpError.AcpError>;
      readonly disableProvider: (
        payload: AcpSchema.DisableProviderRequest,
      ) => Effect.Effect<AcpSchema.DisableProviderResponse, AcpError.AcpError>;
      /**
       * Updates a session configuration option.
       * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
       */
      readonly setSessionModel: (
        payload: AcpSchema.SetSessionModelRequest,
      ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>;
      /**
       * Selects a session mode on ACP v1 agents, which predate mode config
       * options. ACP v2 fails with method-not-found; use `setSessionConfigOption`.
       * @see https://agentclientprotocol.com/protocol/schema#session/set_mode
       */
      readonly setSessionMode: (
        payload: AcpSchemaV1.SetSessionModeRequest,
      ) => Effect.Effect<AcpSchemaV1.SetSessionModeResponse, AcpError.AcpError>;
      readonly setSessionConfigOption: (
        payload: AcpSchema.SetSessionConfigOptionRequest,
      ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>;
      /**
       * Sends a prompt turn to the agent.
       * @see https://agentclientprotocol.com/protocol/schema#session/prompt
       */
      readonly prompt: (
        payload: AcpSchema.PromptRequest,
      ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>;
      /**
       * Sends a real ACP `session/cancel` notification.
       * @see https://agentclientprotocol.com/protocol/schema#session/cancel
       */
      readonly cancel: (
        payload: AcpSchema.CancelNotification,
      ) => Effect.Effect<void, AcpError.AcpError>;
    };
    /**
     * Registers a handler for `session/request_permission`.
     * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
     */
    readonly handleRequestPermission: (
      handler: AcpRequestHandler<
        AcpSchema.RequestPermissionRequest,
        AcpSchema.RequestPermissionResponse
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `elicitation/create` requests.
     * @see https://agentclientprotocol.com/protocol/schema#elicitation/create
     */
    readonly handleElicitation: (
      handler: AcpRequestHandler<
        AcpSchema.CreateElicitationRequest,
        AcpSchema.CreateElicitationResponse
      >,
    ) => Effect.Effect<void>;
    /** Legacy ACP v1 hooks retained for policy compatibility; ACP v2 never advertises them. */
    readonly handleReadTextFile: (
      handler: AcpRequestHandler<AcpSchema.ReadTextFileRequest, AcpSchema.ReadTextFileResponse>,
    ) => Effect.Effect<void>;
    readonly handleWriteTextFile: (
      handler: AcpRequestHandler<
        AcpSchema.WriteTextFileRequest,
        AcpSchema.WriteTextFileResponse | void
      >,
    ) => Effect.Effect<void>;
    readonly handleCreateTerminal: (
      handler: AcpRequestHandler<AcpSchema.CreateTerminalRequest, AcpSchema.CreateTerminalResponse>,
    ) => Effect.Effect<void>;
    readonly handleTerminalOutput: (
      handler: AcpRequestHandler<AcpSchema.TerminalOutputRequest, AcpSchema.TerminalOutputResponse>,
    ) => Effect.Effect<void>;
    readonly handleTerminalWaitForExit: (
      handler: AcpRequestHandler<
        AcpSchema.WaitForTerminalExitRequest,
        AcpSchema.WaitForTerminalExitResponse
      >,
    ) => Effect.Effect<void>;
    readonly handleTerminalKill: (
      handler: AcpRequestHandler<
        AcpSchema.KillTerminalRequest,
        AcpSchema.KillTerminalResponse | void
      >,
    ) => Effect.Effect<void>;
    readonly handleTerminalRelease: (
      handler: AcpRequestHandler<
        AcpSchema.ReleaseTerminalRequest,
        AcpSchema.ReleaseTerminalResponse | void
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `session/update`.
     * @see https://agentclientprotocol.com/protocol/schema#session/update
     */
    readonly handleSessionUpdate: (
      handler: (
        notification: AcpSchema.SessionNotification,
      ) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `elicitation/complete`.
     * @see https://agentclientprotocol.com/protocol/schema#elicitation/complete
     */
    readonly handleElicitationComplete: (
      handler: (
        notification: AcpSchema.CompleteElicitationNotification,
      ) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a fallback extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtRequest: (
      handler: (
        method: string,
        params: unknown,
        context: AcpProtocol.AcpRequestContext,
      ) => Effect.Effect<unknown, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a fallback extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtNotification: (
      handler: (method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a typed extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtRequest: <A, I>(
      method: string,
      payload: Schema.Codec<A, I>,
      handler: AcpRequestHandler<A, unknown>,
    ) => Effect.Effect<void>;
    /**
     * Registers a typed extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtNotification: <A, I>(
      method: string,
      payload: Schema.Codec<A, I>,
      handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
  }
>()("effect-acp/client/AcpClient") {}

interface AcpCoreRequestHandlers {
  requestPermission?: AcpRequestHandler<
    AcpSchema.RequestPermissionRequest,
    AcpSchema.RequestPermissionResponse
  >;
  elicitation?: AcpRequestHandler<
    AcpSchema.CreateElicitationRequest,
    AcpSchema.CreateElicitationResponse
  >;
  readTextFile?: AcpRequestHandler<AcpSchema.ReadTextFileRequest, AcpSchema.ReadTextFileResponse>;
  writeTextFile?: AcpRequestHandler<
    AcpSchema.WriteTextFileRequest,
    AcpSchema.WriteTextFileResponse | void
  >;
  createTerminal?: AcpRequestHandler<
    AcpSchema.CreateTerminalRequest,
    AcpSchema.CreateTerminalResponse
  >;
  terminalOutput?: AcpRequestHandler<
    AcpSchema.TerminalOutputRequest,
    AcpSchema.TerminalOutputResponse
  >;
  terminalWaitForExit?: AcpRequestHandler<
    AcpSchema.WaitForTerminalExitRequest,
    AcpSchema.WaitForTerminalExitResponse
  >;
  terminalKill?: AcpRequestHandler<
    AcpSchema.KillTerminalRequest,
    AcpSchema.KillTerminalResponse | void
  >;
  terminalRelease?: AcpRequestHandler<
    AcpSchema.ReleaseTerminalRequest,
    AcpSchema.ReleaseTerminalResponse | void
  >;
}

interface AcpNotificationHandlers {
  readonly sessionUpdate: BufferedNotificationHandler<AcpSchema.SessionNotification>;
  readonly elicitationComplete: BufferedNotificationHandler<AcpSchema.CompleteElicitationNotification>;
}

interface BufferedNotificationHandler<A> {
  readonly handlers: Array<(notification: A) => Effect.Effect<void, AcpError.AcpError>>;
  readonly pending: Array<A>;
}

function normalizeContentBlock(content: AcpSchemaV2.ContentBlock): AcpSchema.ContentBlock {
  switch (content.type) {
    case "text":
    case "image":
    case "audio":
    case "resource_link":
    case "resource":
      return content as AcpSchema.ContentBlock;
    default:
      return { type: "_unknown", originalType: content.type, raw: content };
  }
}

function normalizeToolCallContent(content: AcpSchemaV2.ToolCallContent): AcpSchema.ToolCallContent {
  if (content.type === "content") {
    const known = content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "content" }>;
    return { ...known, content: normalizeContentBlock(known.content) };
  }
  if (content.type === "terminal") {
    return content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "terminal" }>;
  }
  if (content.type !== "diff") {
    return { type: "_unknown", originalType: content.type, raw: content };
  }

  return content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "diff" }>;
}

function normalizeToolCallUpdate(update: AcpSchemaV2.ToolCallUpdate): AcpSchema.ToolCallUpdate {
  return {
    toolCallId: update.toolCallId,
    ...(update.name === undefined ? {} : { name: update.name }),
    ...(update.title === undefined ? {} : { title: update.title }),
    ...(update.kind === undefined ? {} : { kind: update.kind }),
    ...(update.status === undefined ? {} : { status: update.status }),
    ...(update.content === undefined
      ? {}
      : {
          content: update.content === null ? null : update.content.map(normalizeToolCallContent),
        }),
    ...(update.locations === undefined ? {} : { locations: update.locations }),
    ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
    ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
    ...(update._meta === undefined ? {} : { _meta: update._meta }),
  };
}

function normalizeConfigOption(
  option: AcpSchemaV2.SessionConfigOption,
): AcpSchema.SessionConfigOption | undefined {
  if (option.type === "boolean") {
    // The response union can admit a legacy-shaped option on a v2 session.
    // Validate the v2 branch before exposing an actionable option.
    if (!Schema.is(AcpSchemaV2.SessionConfigOption.members[1])(option)) return undefined;
    const known = option;
    return {
      type: "boolean",
      id: known.configId,
      name: known.name,
      currentValue: known.currentValue,
      ...(known.description === undefined ? {} : { description: known.description }),
      ...(known.category === undefined ? {} : { category: known.category }),
      ...(known._meta === undefined ? {} : { _meta: known._meta }),
    };
  }
  if (option.type === "select") {
    if (!Schema.is(AcpSchemaV2.SessionConfigOption.members[0])(option)) return undefined;
    const known = option;
    return {
      type: "select",
      id: known.configId,
      name: known.name,
      currentValue: known.currentValue,
      options: known.options,
      ...(known.description === undefined ? {} : { description: known.description }),
      ...(known.category === undefined ? {} : { category: known.category }),
      ...(known._meta === undefined ? {} : { _meta: known._meta }),
    };
  }
  return undefined;
}

function normalizeConfigOptions(
  options: ReadonlyArray<AcpSchemaV2.SessionConfigOption> | undefined,
): ReadonlyArray<AcpSchema.SessionConfigOption> | undefined {
  return options?.flatMap((option) => {
    const normalized = normalizeConfigOption(option);
    return normalized === undefined ? [] : [normalized];
  });
}

type V2Update<T extends AcpSchemaV2.SessionUpdate["sessionUpdate"]> = Extract<
  AcpSchemaV2.SessionUpdate,
  { readonly sessionUpdate: T }
>;
type ChildUpdate = V2Update<"subagent_update"> | AcpSchemaV1.SubagentUpdate;
type ChildMessage = V2Update<"session_message"> | AcpSchemaV1.SessionMessage;

type Meta = NonNullable<AcpSchema.SessionNotification["_meta"]> | null;

// Open variants type `_meta` as any JSON; only an object or null is metadata.
const withMeta = (meta: unknown): { readonly _meta?: Meta } =>
  typeof meta === "object" && !Array.isArray(meta) ? { _meta: meta as Meta } : {};

const decodeTextCommandInput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literal("text")),
    hint: Schema.String,
  }),
);

function normalizeCommand(
  command: AcpSchemaV2.AvailableCommand | AcpSchemaV1.AvailableCommand,
): ReadonlyArray<AcpSchema.AvailableCommand> {
  // v2 also lists skills and future entry kinds; only commands are prompt text.
  if ("type" in command && command.type !== "command") return [];
  const input = command.input;
  // v1 text input has no discriminator; an input kind Nodex cannot offer is no input.
  const text = input == null ? undefined : Option.getOrUndefined(decodeTextCommandInput(input));
  return [
    {
      name: command.name,
      description: command.description,
      ...(input == null
        ? {}
        : {
            input:
              text === undefined
                ? null
                : {
                    type: "text" as const,
                    hint: text.hint,
                    ...withMeta((input as { readonly _meta?: unknown })._meta),
                  },
          }),
      ...withMeta(command._meta),
    },
  ];
}

function normalizeCommands(
  commands: ReadonlyArray<AcpSchemaV2.AvailableCommand | AcpSchemaV1.AvailableCommand>,
): ReadonlyArray<AcpSchema.AvailableCommand> {
  return commands.flatMap(normalizeCommand);
}

function normalizeSubagentState(state: NonNullable<ChildUpdate["state"]>): AcpSchema.SubagentState {
  switch (state.state) {
    case "idle": {
      const idle = state as V2Update<"state_update"> & { readonly state: "idle" };
      return {
        state: "idle",
        ...(typeof idle.stopReason === "string" || idle.stopReason === null
          ? { stopReason: idle.stopReason }
          : {}),
        ...("error" in idle && idle.error != null
          ? { error: idle.error as AcpSchemaV2.Error }
          : {}),
        ...withMeta(idle._meta),
      };
    }
    case "running":
    case "requires_action":
    case "unknown":
      return { state: state.state, ...withMeta(state._meta) };
    default:
      // ACP requires a generic busy state, never idle, for a state the Client does not know.
      return { state: "running" };
  }
}

function normalizeSubagentUpdate(update: ChildUpdate): AcpSchema.SessionUpdate {
  return {
    sessionUpdate: "subagent_update",
    sessionId: update.sessionId,
    ...(update.title === undefined ? {} : { title: update.title }),
    ...(update.description === undefined ? {} : { description: update.description }),
    ...(update.state === undefined
      ? {}
      : { state: update.state === null ? null : normalizeSubagentState(update.state) }),
    ...withMeta(update._meta),
  };
}

function normalizeSessionMessage(update: ChildMessage): AcpSchema.SessionUpdate {
  return {
    sessionUpdate: "session_message",
    messageId: update.messageId,
    ...(update.senderSessionId === undefined ? {} : { senderSessionId: update.senderSessionId }),
    ...(update.recipientSessionId === undefined
      ? {}
      : { recipientSessionId: update.recipientSessionId }),
    ...(update.content === undefined
      ? {}
      : {
          content:
            update.content === null
              ? null
              : (update.content as ReadonlyArray<AcpSchemaV2.ContentBlock>).map(
                  normalizeContentBlock,
                ),
        }),
    ...withMeta(update._meta),
  };
}

/** Updates both generations share once decoded, in the shape Nodex consumes. */
function normalizeSharedSessionUpdate(
  update: AcpSchemaV2.SessionUpdate | AcpSchemaV1.SessionUpdate,
): AcpSchema.SessionUpdate | undefined {
  switch (update.sessionUpdate) {
    case "notice":
      return update as AcpSchema.SessionUpdate;
    case "subagent_update":
      return normalizeSubagentUpdate(update as ChildUpdate);
    case "session_message":
      return normalizeSessionMessage(update as ChildMessage);
    case "session_message_chunk": {
      const chunk = update as V2Update<"session_message_chunk">;
      return {
        sessionUpdate: "session_message_chunk",
        messageId: chunk.messageId,
        content: normalizeContentBlock(chunk.content),
        ...withMeta(chunk._meta),
      };
    }
    case "available_commands_update":
      return {
        sessionUpdate: "available_commands_update",
        availableCommands: normalizeCommands(
          (update as V2Update<"available_commands_update">).availableCommands,
        ),
        ...withMeta(update._meta),
      };
    default:
      return undefined;
  }
}

const unknownSessionUpdate = (update: {
  readonly sessionUpdate: string;
}): AcpSchema.SessionUpdate => ({
  sessionUpdate: "_unknown",
  originalSessionUpdate: update.sessionUpdate,
  raw: update,
});

function normalizeSessionUpdate(
  notification: AcpSchemaV2.UpdateSessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const base = {
    sessionId: notification.sessionId,
    ...withMeta(notification._meta),
  };
  const shared = normalizeSharedSessionUpdate(update);
  if (shared !== undefined) return { ...base, update: shared };

  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const known = update as V2Update<
        "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"
      >;
      const content = normalizeContentBlock(known.content);
      return { ...base, update: { ...known, content } };
    }
    case "user_message":
    case "agent_message":
    case "agent_thought": {
      const known = update as V2Update<"user_message" | "agent_message" | "agent_thought">;
      const content = known.content;
      return {
        ...base,
        update: {
          ...known,
          ...(content === undefined
            ? {}
            : {
                content:
                  content === null
                    ? null
                    : (content as ReadonlyArray<AcpSchemaV2.ContentBlock>).map(
                        normalizeContentBlock,
                      ),
              }),
        },
      } as AcpSchema.SessionNotification;
    }
    case "tool_call_update": {
      const known = update as V2Update<"tool_call_update">;
      return {
        ...base,
        update: { sessionUpdate: "tool_call_update", ...normalizeToolCallUpdate(known) },
      };
    }
    case "tool_call_content_chunk": {
      const known = update as V2Update<"tool_call_content_chunk">;
      return {
        ...base,
        update: {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: known.toolCallId,
          content: normalizeToolCallContent(known.content),
          ...withMeta(known._meta),
        },
      };
    }
    case "config_option_update": {
      const known = update as V2Update<"config_option_update">;
      return {
        ...base,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: normalizeConfigOptions(known.configOptions) ?? [],
          ...withMeta(known._meta),
        },
      };
    }
    case "state_update": {
      const known = update as V2Update<"state_update">;
      switch (known.state) {
        case "running":
        case "idle":
        case "requires_action":
        case "unknown":
          return { ...base, update: known } as AcpSchema.SessionNotification;
        default:
          // ACP requires a generic busy state, never idle, for a state the Client does not know.
          return { ...base, update: { sessionUpdate: "state_update", state: "running" } };
      }
    }
    case "terminal_update":
    case "terminal_output_chunk":
    case "plan_update":
    case "plan_removed":
    case "session_info_update":
    case "usage_update":
    case "compaction_update":
    case "compaction_summary_chunk":
    case "replay_complete":
    case "cursor_update":
    case "prompt_suggestions_update":
      return { ...base, update } as AcpSchema.SessionNotification;
    default:
      return { ...base, update: unknownSessionUpdate(update) };
  }
}

function normalizeV1ToolCallContent(
  content: ReadonlyArray<AcpSchemaV1.ToolCallContent> | null | undefined,
) {
  return content == null
    ? content
    : content.map((entry) => normalizeToolCallContent(entry as AcpSchemaV2.ToolCallContent));
}

function normalizeV1SessionUpdate(
  notification: AcpSchemaV1.SessionNotification,
): AcpSchema.SessionNotification {
  const shared = normalizeSharedSessionUpdate(notification.update);
  if (shared !== undefined) return { ...notification, update: shared };
  const update = notification.update;
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    // v1 defines a null tool name as unchanged; v2 consumers read null as a clear.
    const { name, content, ...rest } = update;
    return {
      ...notification,
      update: {
        ...rest,
        ...(name === null || name === undefined ? {} : { name }),
        ...(content === undefined ? {} : { content: normalizeV1ToolCallContent(content) }),
      },
    } as unknown as AcpSchema.SessionNotification;
  }
  return notification as unknown as AcpSchema.SessionNotification;
}

function toV2McpServer(server: AcpSchema.McpServer): AcpSchemaV2.McpServer {
  if ("type" in server) return server;
  return {
    type: "stdio",
    name: server.name,
    command: server.command,
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(server._meta === undefined ? {} : { _meta: server._meta }),
  };
}

function toV2ResumeRequest(
  request: AcpSchema.ResumeSessionRequest,
  replayFrom?: AcpSchemaV2.ReplayFrom,
): AcpSchemaV2.ResumeSessionRequest {
  const { mcpServers, ...rest } = request;
  return {
    ...rest,
    ...(mcpServers === undefined ? {} : { mcpServers: mcpServers.map(toV2McpServer) }),
    ...(replayFrom === undefined ? {} : { replayFrom }),
  };
}

function toV2ForkRequest(request: AcpSchema.ForkSessionRequest): AcpSchemaV2.ForkSessionRequest {
  const { mcpServers, ...rest } = request;
  return {
    ...rest,
    ...(mcpServers === undefined ? {} : { mcpServers: mcpServers.map(toV2McpServer) }),
  };
}

function normalizeInitializeResponse(
  response: AcpSchemaV2.InitializeResponse,
): AcpSchema.InitializeResponse {
  const session = response.capabilities?.session;
  const prompt = session?.prompt;
  const mcp = session?.mcp;
  return {
    protocolVersion: response.protocolVersion,
    agentInfo: response.info,
    agentCapabilities: {
      ...(response.capabilities?._meta === undefined ? {} : { _meta: response.capabilities._meta }),
      loadSession: session !== undefined && session !== null,
      promptCapabilities: {
        image: prompt?.image != null,
        audio: prompt?.audio != null,
        embeddedContext: prompt?.embeddedContext != null,
      },
      mcpCapabilities: {
        stdio: mcp?.stdio != null,
        http: mcp?.http != null,
        acp: mcp?.acp != null,
      },
      ...(session == null
        ? {}
        : {
            sessionCapabilities: {
              list: {},
              resume: {},
              close: {},
              ...(session.delete == null ? {} : { delete: {} }),
              ...(session.fork == null ? {} : { fork: {} }),
              ...(session.additionalDirectories == null ? {} : { additionalDirectories: {} }),
            },
          }),
      ...(response.capabilities?.providers == null ? {} : { providers: {} }),
      ...(response.authMethods === undefined || response.authMethods.length === 0
        ? {}
        : { auth: { logout: {} } }),
    },
    ...(response.authMethods === undefined
      ? {}
      : {
          authMethods: response.authMethods
            .map((method) => {
              const record = method as AcpSchemaV2.AuthMethod;
              const base = {
                id: record.methodId,
                name: record.name,
                ...(typeof record.description === "string" || record.description === null
                  ? { description: record.description }
                  : {}),
                ...withMeta(record._meta),
              };
              if (
                record.type === "env_var" &&
                Array.isArray(record.vars) &&
                record.vars.every(
                  (variable) =>
                    typeof variable === "object" &&
                    variable !== null &&
                    typeof (variable as { readonly name?: unknown }).name === "string",
                )
              ) {
                return {
                  ...base,
                  type: "env_var" as const,
                  vars: record.vars.map((variable) => {
                    const value = variable as { readonly name: string; readonly label?: unknown };
                    return {
                      name: value.name,
                      ...(typeof value.label === "string" ? { label: value.label } : {}),
                    };
                  }),
                  ...(typeof record.link === "string" ? { link: record.link } : {}),
                };
              }
              if (record.type === "agent") return { ...base, type: "agent" as const };
              if (record.type !== "terminal") return undefined;
              return {
                ...base,
                type: "terminal" as const,
                ...(Array.isArray(record.args)
                  ? {
                      args: record.args.filter(
                        (argument): argument is string => typeof argument === "string",
                      ),
                    }
                  : {}),
                ...(Array.isArray(record.env)
                  ? {
                      env: Object.fromEntries(
                        (record.env as ReadonlyArray<AcpSchemaV2.EnvVariable>).map((variable) => [
                          variable.name,
                          variable.value,
                        ]),
                      ),
                    }
                  : {}),
              };
            })
            .filter(Predicate.isNotUndefined),
        }),
    ...(response._meta === undefined ? {} : { _meta: response._meta }),
  };
}

function toV2InitializeRequest(
  request: AcpSchema.InitializeRequest,
): AcpSchemaV2.InitializeRequest {
  const capabilities = request.clientCapabilities;
  return {
    protocolVersion: 2,
    info: request.clientInfo ?? { name: "nodex", version: "unknown" },
    capabilities: {
      ...(capabilities?.auth?.terminal === true ? { auth: { terminal: {} } } : {}),
      ...(capabilities?.elicitation == null ? {} : { elicitation: capabilities.elicitation }),
      ...(capabilities?._meta === undefined ? {} : { _meta: capabilities._meta }),
    },
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
  };
}

function toNegotiatingInitializeRequest(
  request: AcpSchema.InitializeRequest,
): AcpSchemaV1.InitializeRequest | AcpSchemaV2.InitializeRequest {
  return {
    ...toV2InitializeRequest(request),
    clientCapabilities: request.clientCapabilities ?? {},
    ...(request.clientInfo === undefined ? {} : { clientInfo: request.clientInfo }),
  } as unknown as AcpSchemaV1.InitializeRequest | AcpSchemaV2.InitializeRequest;
}

function isV2InitializeResponse(
  response: AcpSchemaV1.InitializeResponse | AcpSchemaV2.InitializeResponse,
): response is AcpSchemaV2.InitializeResponse {
  return "info" in response;
}

const decodeResponse =
  <A, I>(method: string, schema: Schema.Codec<A, I>) =>
  (response: unknown) =>
    Schema.decodeUnknownEffect(schema)(response).pipe(
      Effect.mapError((cause) =>
        AcpError.AcpProtocolParseError.fromSchemaError("decode-response-payload", method, cause),
      ),
    );

const setupResponseDecoder =
  (lists: Parameters<typeof withoutMalformedItems>[1]) =>
  <A, I>(method: string, schema: Schema.Codec<A, I>) =>
  (response: unknown) =>
    decodeResponse(method, schema)(withoutMalformedItems(response, lists));
const decodeV1SetupResponse = setupResponseDecoder({
  configOptions: Schema.is(AcpSchemaV1.SessionConfigOption),
});
const decodeV2SetupResponse = setupResponseDecoder({
  configOptions: Schema.is(AcpSchemaV2.SessionConfigOption),
  availableCommands: Schema.is(AcpSchemaV2.AvailableCommand),
});

function normalizeV2SessionSetupResponse(
  response:
    | AcpSchemaV2.NewSessionResponse
    | AcpSchemaV2.ResumeSessionResponse
    | AcpSchemaV2.ForkSessionResponse,
) {
  const configOptions = normalizeConfigOptions(response.configOptions);
  return {
    ...("sessionId" in response ? { sessionId: response.sessionId } : {}),
    ...(configOptions === undefined ? {} : { configOptions }),
    ...(response.availableCommands === undefined
      ? {}
      : { availableCommands: normalizeCommands(response.availableCommands) }),
    ...withMeta(response._meta),
  };
}

function normalizePermissionRequest(
  request: AcpSchemaV2.RequestPermissionRequest,
  context: AcpProtocol.AcpRequestContext,
): AcpSchema.RequestPermissionRequest {
  const subject = request.subject;
  const toolCall =
    subject?.type === "tool_call" && "toolCall" in subject
      ? normalizeToolCallUpdate(subject.toolCall as AcpSchemaV2.ToolCallUpdate)
      : {
          toolCallId:
            subject?.type === "command" &&
            "toolCallId" in subject &&
            typeof subject.toolCallId === "string"
              ? subject.toolCallId
              : context.requestId,
          title: request.title,
          kind: subject?.type === "command" ? ("execute" as const) : ("other" as const),
        };
  return {
    sessionId: request.sessionId,
    title: request.title,
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(subject === undefined ? {} : { subject }),
    toolCall,
    options: request.options,
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
  };
}

export const make = Effect.fn("effect-acp/AcpClient.make")(function* (
  stdio: AcpProtocol.AcpStdio,
  options: AcpClientOptions = {},
  terminationError?: Effect.Effect<AcpError.AcpError>,
): Effect.fn.Return<AcpClient["Service"], never, Scope.Scope> {
  const coreHandlers: AcpCoreRequestHandlers = {};
  const notificationHandlers: AcpNotificationHandlers = {
    sessionUpdate: { handlers: [], pending: [] },
    elicitationComplete: { handlers: [], pending: [] },
  };
  const promptCompletions = new Map<
    string,
    Deferred.Deferred<AcpSchema.PromptResponse, AcpError.AcpError>
  >();
  const extRequestHandlers = new Map<string, AcpRequestHandler<unknown, unknown>>();
  const extNotificationHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<void, AcpError.AcpError>
  >();
  let unknownExtRequestHandler:
    | ((
        method: string,
        params: unknown,
        context: AcpProtocol.AcpRequestContext,
      ) => Effect.Effect<unknown, AcpError.AcpError>)
    | undefined;
  let unknownExtNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>)
    | undefined;
  let negotiatedProtocolGeneration: 1 | 2 | undefined;

  const runNotificationHandlers = <A>(
    registration: BufferedNotificationHandler<A>,
    notification: A,
  ) =>
    // One handler failing or dying does not stop the others, or the reader.
    Effect.forEach(
      registration.handlers,
      (handler) => isolateNotificationHandler(handler(notification)),
      { discard: true },
    );

  const flushBufferedNotifications = <A>(registration: BufferedNotificationHandler<A>) =>
    Effect.suspend(() => {
      if (registration.handlers.length === 0 || registration.pending.length === 0) {
        return Effect.void;
      }
      const pending = registration.pending.splice(0, registration.pending.length);
      return Effect.forEach(
        pending,
        (notification) => runNotificationHandlers(registration, notification),
        {
          discard: true,
        },
      );
    });

  const dispatchNotification = (notification: AcpProtocol.AcpIncomingNotification) => {
    switch (notification._tag) {
      case "SessionUpdate": {
        const normalized = notification.params as AcpSchema.SessionNotification;
        const state = normalized.update;
        const completePrompt =
          state.sessionUpdate === "state_update" && state.state === "idle"
            ? Effect.suspend(() => {
                const idle = state as Extract<
                  AcpSchema.SessionUpdate,
                  { readonly sessionUpdate: "state_update"; readonly state: "idle" }
                >;
                const completion = promptCompletions.get(normalized.sessionId);
                if (completion === undefined) return Effect.void;
                promptCompletions.delete(normalized.sessionId);
                return Deferred.succeed(completion, {
                  stopReason: idle.stopReason ?? "end_turn",
                  ...(idle.usage === undefined ? {} : { usage: idle.usage }),
                  ...(idle.error === undefined ? {} : { error: idle.error }),
                  ...withMeta(idle._meta),
                }).pipe(Effect.asVoid);
              })
            : Effect.void;
        if (notificationHandlers.sessionUpdate.handlers.length === 0) {
          notificationHandlers.sessionUpdate.pending.push(normalized);
          return completePrompt;
        }
        return Effect.all(
          [completePrompt, runNotificationHandlers(notificationHandlers.sessionUpdate, normalized)],
          { discard: true },
        );
      }
      case "ElicitationComplete": {
        if (notificationHandlers.elicitationComplete.handlers.length === 0) {
          notificationHandlers.elicitationComplete.pending.push(notification.params);
          return Effect.void;
        }
        return runNotificationHandlers(
          notificationHandlers.elicitationComplete,
          notification.params,
        );
      }
      case "ExtNotification": {
        const handler = extNotificationHandlers.get(notification.method);
        if (handler) {
          return handler(notification.params);
        }
        return unknownExtNotificationHandler
          ? unknownExtNotificationHandler(notification.method, notification.params)
          : Effect.void;
      }
    }
  };

  const dispatchExtRequest = (
    method: string,
    params: unknown,
    context: AcpProtocol.AcpRequestContext,
  ) => {
    const handler = extRequestHandlers.get(method);
    if (handler) {
      return handler(params, context);
    }
    return unknownExtRequestHandler
      ? unknownExtRequestHandler(method, params, context)
      : Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
  };

  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio: stdio,
    ...(terminationError ? { terminationError } : {}),
    serverRequestMethods: new Set(AcpRpcs.CompatClientRpcs.requests.keys()),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.onIncomingRequest ? { onIncomingRequest: options.onIncomingRequest } : {}),
    onTermination: (error) =>
      Effect.all(
        [
          ...Array.from(promptCompletions.values(), (completion) =>
            Deferred.fail(completion, error).pipe(Effect.asVoid),
          ),
          options.onTermination?.(error) ?? Effect.void,
        ],
        { discard: true },
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            promptCompletions.clear();
          }),
        ),
      ),
    ...(options.onOutgoingResponseFailure
      ? { onOutgoingResponseFailure: options.onOutgoingResponseFailure }
      : {}),
    ...(options.onOutgoingResponse ? { onOutgoingResponse: options.onOutgoingResponse } : {}),
    transformSessionUpdate: (notification) => {
      const normalized =
        negotiatedProtocolGeneration === 1
          ? normalizeV1SessionUpdate(notification as AcpSchemaV1.SessionNotification)
          : normalizeSessionUpdate(notification as AcpSchemaV2.UpdateSessionNotification);
      return options.transformSessionUpdate?.(normalized) ?? normalized;
    },
    onNotification: dispatchNotification,
    onExtRequest: dispatchExtRequest,
  });

  const requestContext = (
    requestId: RpcMessage.RequestId,
    method: string,
  ): AcpProtocol.AcpRequestContext => ({
    requestId: AcpProtocol.acpRequestIdentity(requestId),
    method,
  });

  const layerClientHandler = AcpRpcs.CompatClientRpcs.toLayer(
    AcpRpcs.CompatClientRpcs.of({
      [CLIENT_METHODS.session_request_permission]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.requestPermission,
          "toolCall" in payload
            ? (payload as AcpSchema.RequestPermissionRequest)
            : normalizePermissionRequest(
                payload,
                requestContext(requestId, CLIENT_METHODS.session_request_permission),
              ),
          CLIENT_METHODS.session_request_permission,
          requestContext(requestId, CLIENT_METHODS.session_request_permission),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.session_elicitation]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.elicitation,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.session_elicitation,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.session_elicitation),
        ).pipe(
          Effect.map(({ _meta, ...action }) => ({
            action,
            ...(_meta === undefined ? {} : { _meta }),
          })),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.unstable_session_elicitation]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.elicitation,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.unstable_session_elicitation,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.unstable_session_elicitation),
        ).pipe(
          Effect.map(({ _meta, ...action }) => ({
            action,
            ...(_meta === undefined ? {} : { _meta }),
          })),
        ),
      [CLIENT_METHODS.elicitation_create]: (payload, { requestId }) =>
        decodeElicitationRequest(payload).pipe(
          Effect.mapError((error) => error.toProtocolError()),
          Effect.flatMap((request) =>
            runHandler(
              coreHandlers.elicitation,
              request,
              CLIENT_METHODS.elicitation_create,
              requestContext(requestId, CLIENT_METHODS.elicitation_create),
            ),
          ),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.fs_read_text_file]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.readTextFile,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.fs_read_text_file,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.fs_read_text_file),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.fs_write_text_file]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.writeTextFile,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.fs_write_text_file,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.fs_write_text_file),
        ).pipe(Effect.map((result) => result ?? {})),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_create]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.createTerminal,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_create,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_create),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_output]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalOutput,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_output,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_output),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_wait_for_exit]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalWaitForExit,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_wait_for_exit,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_wait_for_exit),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_kill]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalKill,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_kill,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_kill),
        ).pipe(Effect.map((result) => result ?? {})),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_release]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalRelease,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_release,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_release),
        ).pipe(Effect.map((result) => result ?? {})),
    }),
  );

  yield* RpcServer.make(AcpRpcs.CompatClientRpcs, { disableFatalDefects: true }).pipe(
    // runHandler logs handler defects with their method. A reporter inherited
    // from the caller (a WebSocket request, say) would log them again.
    Effect.provideService(ErrorReporter.CurrentErrorReporters, new Set()),
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(layerClientHandler),
    Effect.forkScoped,
  );

  let nextRpcRequestId = 2 ** 32;
  const rpc = yield* RpcClient.make(AcpRpcs.CompatAgentRpcs, {
    generateRequestId: () => RpcMessage.RequestId(nextRpcRequestId++),
  }).pipe(Effect.provideService(RpcClient.Protocol, transport.clientProtocol));

  return AcpClient.of({
    protocolGeneration: Effect.sync(() => negotiatedProtocolGeneration),
    raw: {
      notifications: transport.incoming,
      request: transport.request,
      notify: transport.notify,
    },
    agent: {
      initialize: (payload) =>
        callRpc(
          AGENT_METHODS.initialize,
          rpc[AGENT_METHODS.initialize](toNegotiatingInitializeRequest(payload)),
        ).pipe(
          Effect.map((response) => {
            // ACP v1 protocolVersion values were not generation identifiers in
            // every shipped agent. Antigravity, for example, reports version 2
            // with the v1 agentInfo/agentCapabilities response shape. The
            // response discriminator determines the wire generation reliably.
            if (isV2InitializeResponse(response)) {
              negotiatedProtocolGeneration = 2;
              return normalizeInitializeResponse(response);
            }
            negotiatedProtocolGeneration = 1;
            return response as AcpSchema.InitializeResponse;
          }),
        ),
      authenticate: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.authenticate,
              rpc[AcpRpcs.V1_AGENT_METHODS.authenticate](payload),
            )
          : callRpc(AGENT_METHODS.auth_login, rpc[AGENT_METHODS.auth_login](payload)),
      logout: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(AcpRpcs.V1_AGENT_METHODS.logout, rpc[AcpRpcs.V1_AGENT_METHODS.logout](payload))
          : callRpc(AGENT_METHODS.auth_logout, rpc[AGENT_METHODS.auth_logout](payload)),
      createSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_new,
              rpc[AGENT_METHODS.session_new](payload as AcpSchemaV1.NewSessionRequest),
            ).pipe(
              Effect.flatMap(
                decodeV1SetupResponse(AGENT_METHODS.session_new, AcpRpcs.V1NewSessionResponse),
              ),
              Effect.map((response) => response as AcpSchema.NewSessionResponse),
            )
          : callRpc(
              AGENT_METHODS.session_new,
              rpc[AGENT_METHODS.session_new]({
                ...payload,
                mcpServers: payload.mcpServers.map(toV2McpServer),
              }),
            ).pipe(
              Effect.flatMap(
                decodeV2SetupResponse(AGENT_METHODS.session_new, AcpSchemaV2.NewSessionResponse),
              ),
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(response) as AcpSchema.NewSessionResponse,
              ),
            ),
      loadSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.session_load,
              rpc[AcpRpcs.V1_AGENT_METHODS.session_load](payload as AcpSchemaV1.LoadSessionRequest),
            ).pipe(
              Effect.flatMap(
                decodeV1SetupResponse(
                  AcpRpcs.V1_AGENT_METHODS.session_load,
                  AcpRpcs.V1LoadSessionResponse,
                ),
              ),
              Effect.map((response) => response as AcpSchema.LoadSessionResponse),
            )
          : callRpc(
              AGENT_METHODS.session_resume,
              rpc[AGENT_METHODS.session_resume](toV2ResumeRequest(payload, { type: "start" })),
            ).pipe(
              Effect.flatMap(
                decodeV2SetupResponse(
                  AGENT_METHODS.session_resume,
                  AcpSchemaV2.ResumeSessionResponse,
                ),
              ),
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(response) as AcpSchema.LoadSessionResponse,
              ),
            ),
      listSessions: (payload) =>
        callRpc(AGENT_METHODS.session_list, rpc[AGENT_METHODS.session_list](payload)).pipe(
          Effect.map((response) => response as AcpSchema.ListSessionsResponse),
        ),
      forkSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_fork,
              rpc[AGENT_METHODS.session_fork](payload as AcpSchemaV1.ForkSessionRequest),
            ).pipe(
              Effect.flatMap(
                decodeV1SetupResponse(AGENT_METHODS.session_fork, AcpRpcs.V1ForkSessionResponse),
              ),
              Effect.map((response) => response as AcpSchema.ForkSessionResponse),
            )
          : callRpc(
              AGENT_METHODS.session_fork,
              rpc[AGENT_METHODS.session_fork](toV2ForkRequest(payload)),
            ).pipe(
              Effect.flatMap(
                decodeV2SetupResponse(AGENT_METHODS.session_fork, AcpSchemaV2.ForkSessionResponse),
              ),
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(response) as AcpSchema.ForkSessionResponse,
              ),
            ),
      resumeSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_resume,
              rpc[AGENT_METHODS.session_resume](payload as AcpSchemaV1.ResumeSessionRequest),
            ).pipe(
              Effect.flatMap(
                decodeV1SetupResponse(
                  AGENT_METHODS.session_resume,
                  AcpRpcs.V1ResumeSessionResponse,
                ),
              ),
              Effect.map((response) => response as AcpSchema.ResumeSessionResponse),
            )
          : callRpc(
              AGENT_METHODS.session_resume,
              rpc[AGENT_METHODS.session_resume](
                toV2ResumeRequest(payload, payload.replayFrom ?? undefined),
              ),
            ).pipe(
              Effect.flatMap(
                decodeV2SetupResponse(
                  AGENT_METHODS.session_resume,
                  AcpSchemaV2.ResumeSessionResponse,
                ),
              ),
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(response) as AcpSchema.ResumeSessionResponse,
              ),
            ),
      closeSession: (payload) =>
        callRpc(AGENT_METHODS.session_close, rpc[AGENT_METHODS.session_close](payload)).pipe(
          Effect.map((response) => response as AcpSchema.CloseSessionResponse),
        ),
      deleteSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.session_delete))
          : callRpc(AGENT_METHODS.session_delete, rpc[AGENT_METHODS.session_delete](payload)),
      listProviders: (payload) =>
        negotiatedProtocolGeneration === 1
          ? Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.providers_list))
          : callRpc(AGENT_METHODS.providers_list, rpc[AGENT_METHODS.providers_list](payload)),
      setProvider: (payload) =>
        negotiatedProtocolGeneration === 1
          ? Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.providers_set))
          : callRpc(AGENT_METHODS.providers_set, rpc[AGENT_METHODS.providers_set](payload)),
      disableProvider: (payload) =>
        negotiatedProtocolGeneration === 1
          ? Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.providers_disable))
          : callRpc(AGENT_METHODS.providers_disable, rpc[AGENT_METHODS.providers_disable](payload)),
      setSessionModel: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.session_set_model,
              rpc[AcpRpcs.V1_AGENT_METHODS.session_set_model](payload),
            )
          : Effect.fail(
              AcpError.AcpRequestError.methodNotFound(AcpRpcs.V1_AGENT_METHODS.session_set_model),
            ),
      setSessionMode: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.session_set_mode,
              rpc[AcpRpcs.V1_AGENT_METHODS.session_set_mode](payload),
            )
          : Effect.fail(
              AcpError.AcpRequestError.methodNotFound(AcpRpcs.V1_AGENT_METHODS.session_set_mode),
            ),
      setSessionConfigOption: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_set_config_option,
              rpc[AGENT_METHODS.session_set_config_option](
                payload as AcpSchemaV1.SetSessionConfigOptionRequest,
              ),
            ).pipe(Effect.map((response) => response as AcpSchema.SetSessionConfigOptionResponse))
          : callRpc(
              AGENT_METHODS.session_set_config_option,
              rpc[AGENT_METHODS.session_set_config_option]({
                ...payload,
                type: "type" in payload && payload.type === "boolean" ? "boolean" : "id",
              }),
            ).pipe(
              Effect.map((response) => ({
                configOptions:
                  normalizeConfigOptions(
                    (response as AcpSchemaV2.SetSessionConfigOptionResponse).configOptions,
                  ) ?? [],
              })),
            ),
      prompt: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_prompt,
              rpc[AGENT_METHODS.session_prompt](payload as AcpSchemaV1.PromptRequest),
            ).pipe(Effect.map((response) => response as AcpSchema.PromptResponse))
          : Effect.gen(function* () {
              const existing = promptCompletions.get(payload.sessionId);
              if (existing !== undefined) {
                return yield* AcpError.AcpRequestError.internalError(
                  `ACP session '${payload.sessionId}' already has an active prompt.`,
                );
              }
              const completion = yield* Deferred.make<
                AcpSchema.PromptResponse,
                AcpError.AcpError
              >();
              promptCompletions.set(payload.sessionId, completion);
              return yield* callRpc(
                AGENT_METHODS.session_prompt,
                rpc[AGENT_METHODS.session_prompt](payload as AcpSchemaV2.PromptRequest),
              ).pipe(
                Effect.andThen(Deferred.await(completion)),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (promptCompletions.get(payload.sessionId) === completion) {
                      promptCompletions.delete(payload.sessionId);
                    }
                  }),
                ),
              );
            }),
      cancel: (payload) => transport.notify(AGENT_METHODS.session_cancel, payload),
    },
    handleRequestPermission: (handler) =>
      Effect.suspend(() => {
        coreHandlers.requestPermission = handler;
        return Effect.void;
      }),
    handleElicitation: (handler) =>
      Effect.suspend(() => {
        coreHandlers.elicitation = handler;
        return Effect.void;
      }),
    handleReadTextFile: (handler) =>
      Effect.sync(() => {
        coreHandlers.readTextFile = handler;
      }),
    handleWriteTextFile: (handler) =>
      Effect.sync(() => {
        coreHandlers.writeTextFile = handler;
      }),
    handleCreateTerminal: (handler) =>
      Effect.sync(() => {
        coreHandlers.createTerminal = handler;
      }),
    handleTerminalOutput: (handler) =>
      Effect.sync(() => {
        coreHandlers.terminalOutput = handler;
      }),
    handleTerminalWaitForExit: (handler) =>
      Effect.sync(() => {
        coreHandlers.terminalWaitForExit = handler;
      }),
    handleTerminalKill: (handler) =>
      Effect.sync(() => {
        coreHandlers.terminalKill = handler;
      }),
    handleTerminalRelease: (handler) =>
      Effect.sync(() => {
        coreHandlers.terminalRelease = handler;
      }),
    handleSessionUpdate: (handler) =>
      Effect.suspend(() => {
        notificationHandlers.sessionUpdate.handlers.push(handler);
        return flushBufferedNotifications(notificationHandlers.sessionUpdate);
      }),
    handleElicitationComplete: (handler) =>
      Effect.suspend(() => {
        notificationHandlers.elicitationComplete.handlers.push(handler);
        return flushBufferedNotifications(notificationHandlers.elicitationComplete);
      }),
    handleUnknownExtRequest: (handler) =>
      Effect.suspend(() => {
        unknownExtRequestHandler = handler;
        return Effect.void;
      }),
    handleUnknownExtNotification: (handler) =>
      Effect.suspend(() => {
        unknownExtNotificationHandler = handler;
        return Effect.void;
      }),
    handleExtRequest: (method, payload, handler) =>
      Effect.suspend(() => {
        extRequestHandlers.set(method, decodeExtRequestRegistration(method, payload, handler));
        return Effect.void;
      }),
    handleExtNotification: (method, payload, handler) =>
      Effect.suspend(() => {
        extNotificationHandlers.set(
          method,
          decodeExtNotificationRegistration(method, payload, handler),
        );
        return Effect.void;
      }),
  });
});

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: AcpClientOptions = {},
): Layer.Layer<AcpClient> => {
  const stdio = {
    ...makeChildStdio(handle),
    stdin: options.transformStdout?.(handle.stdout) ?? handle.stdout,
  };
  const terminationError = makeTerminationError(handle);
  return Layer.effect(AcpClient, make(stdio, options, terminationError));
};
