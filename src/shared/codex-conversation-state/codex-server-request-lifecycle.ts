import { current, produce, type Draft } from "immer";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
} from "./codex-turn-mutation";
import type {
  RequestId,
  ServerNotification,
  ServerRequest,
} from "@nodex/codex-app-server-protocol";
import type {
  CurrentTimeReadResponse,
  DynamicToolCallResponse,
  McpServerElicitationAction,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ToolRequestUserInputParams,
} from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalUserInputAnswers,
  CodexCanonicalMcpElicitation,
  CodexCanonicalPlanImplementationRequest,
  CodexCanonicalRequestSyntheticItem,
  CodexCanonicalServerRequest,
  CodexCanonicalServerRequestExtension,
  CodexCanonicalSetupContextPickerResponse,
  CodexCanonicalSetupCodexStepResponse,
  CodexCanonicalConversationState,
} from "./codex-conversation-state";
import type { CodexApprovalRequestMethod } from "../codex-approval";
import {
  CODEX_APP_TOOL_NAMESPACE,
  hasCodexDynamicToolIdentity,
} from "../codex-dynamic-tool-identity";

type JsonValue = McpServerElicitationRequestResponse["content"];

export type CodexServerRequestResolvedNotification = Extract<
  ServerNotification,
  {
    method: "serverRequest/resolved";
  }
>;
type DynamicToolCallRequest = Extract<
  ServerRequest,
  {
    method: "item/tool/call";
  }
>;
type McpElicitationRequest = Extract<
  ServerRequest,
  {
    method: "mcpServer/elicitation/request";
  }
>;
type ApprovalRequest = Extract<
  ServerRequest,
  {
    method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
  }
>;
type UserInputRequest = Extract<
  ServerRequest,
  {
    method: "item/tool/requestUserInput";
  }
>;
export interface CodexServerRequestLifecycleContext {
  readonly now: () => number;
  readonly isOpenAIFormElicitationsEnabled?: boolean;
}

export type CodexServerRequestAutoResponseEffect =
  | {
      readonly type: "respond";
      readonly method: "currentTime/read";
      readonly requestId: RequestId;
      readonly response: CurrentTimeReadResponse;
    }
  | {
      readonly type: "respond";
      readonly method: "mcpServer/elicitation/request";
      readonly requestId: RequestId;
      readonly response: McpServerElicitationRequestResponse;
    }
  | {
      readonly type: "respond";
      readonly method: "item/tool/call";
      readonly requestId: RequestId;
      readonly response: DynamicToolCallResponse;
    }
  | {
      readonly type: "respond";
      readonly method: "item/tool/requestSetupCodexContextPicker";
      readonly requestId: RequestId;
      readonly response: CodexCanonicalSetupContextPickerResponse;
    };

export type CodexServerRequestLifecycleEffect =
  | CodexServerRequestAutoResponseEffect
  | {
      readonly type: "dispatchDynamicToolCall";
      readonly request: DynamicToolCallRequest;
    }
  | {
      readonly type: "approvalRequestReceived";
      readonly request: ApprovalRequest;
    }
  | {
      readonly type: "userInputRequestReceived";
      readonly request: UserInputRequest;
    }
  | {
      readonly type: "refreshFileApprovalContext";
      readonly threadId: string;
    };

export type CodexServerRequestLifecycleDisposition =
  | "stored"
  | "dispatched"
  | "responded"
  | "ignored"
  | "foreignConversation"
  | "resolved";

export interface CodexServerRequestLifecycleResult {
  readonly state: CodexCanonicalConversationState;
  readonly effects: readonly CodexServerRequestLifecycleEffect[];
  readonly disposition: CodexServerRequestLifecycleDisposition;
  readonly stateChanged: boolean;
  /** Projection metadata from the same raw transition; never a second state authority. */
  readonly turnMutations: readonly CodexServerRequestRawTurnMutation[];
  /** Raw envelopes selected in exact arrival order for caller-owned transport. */
  readonly selectedRequests: readonly CodexCanonicalServerRequest[];
  readonly selectedRequestIds: readonly RequestId[];
}

export interface CodexServerRequestRawTurnState {
  readonly turnId: string | null;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly hasError: boolean;
  readonly items: readonly unknown[];
  readonly hookRuns?: readonly unknown[];
  readonly turnStartedAtMs?: number | null;
}

/** Minimal adapter-facing state: no fake protocol Thread or complete turn params. */
export interface CodexServerRequestRawState {
  readonly threadId: string;
  readonly turns: readonly CodexServerRequestRawTurnState[];
  readonly requests: readonly CodexCanonicalServerRequest[];
  readonly hasUnreadTurn: boolean;
}

export interface CodexServerRequestRawTurnMutation {
  readonly turnIndex: number;
  readonly turn: CodexServerRequestRawTurnState;
  readonly syntheticItem: CodexCanonicalRequestSyntheticItem;
}

export interface CodexServerRequestRawLifecycleResult {
  readonly state: CodexServerRequestRawState;
  readonly effects: readonly CodexServerRequestLifecycleEffect[];
  readonly disposition: CodexServerRequestLifecycleDisposition;
  readonly stateChanged: boolean;
  readonly turnMutations: readonly CodexServerRequestRawTurnMutation[];
  /** Requests to send a caller-owned response to, preserving arrival order. */
  readonly selectedRequests: readonly CodexCanonicalServerRequest[];
  readonly selectedRequestIds: readonly RequestId[];
}

export interface CodexServerRequestClassification {
  readonly source: "generated" | "private";
  readonly behavior:
    | "store"
    | "storeAndSynthesize"
    | "specialDynamic"
    | "dispatchDynamic"
    | "respond"
    | "ignore";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
}

function toJsonObject(value: unknown): Record<string, JsonValue | undefined> | null {
  if (!isRecord(value) || !isJsonValue(value)) return null;
  return value;
}

function parseHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isChatGptHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "chatgpt.com" ||
    normalized === "chatgpt-staging.com" ||
    normalized.endsWith(".chatgpt.com") ||
    normalized.endsWith(".chatgpt-staging.com")
  );
}

function normalizeMcpMeta(value: JsonValue | null): {
  readonly riskLevel?: "low" | "high";
  readonly subtitle?: string;
} {
  const meta = toJsonObject(value);
  if (!meta) return {};
  const riskLevel = meta.riskLevel ?? undefined;
  const subtitle = meta.subtitle ?? undefined;
  if (
    (riskLevel !== undefined && riskLevel !== "low" && riskLevel !== "high") ||
    (subtitle !== undefined && typeof subtitle !== "string")
  ) {
    return {};
  }
  return {
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(subtitle === undefined ? {} : { subtitle }),
  };
}

function normalizePersist(
  value: unknown,
): "session" | "always" | Array<"session" | "always"> | undefined {
  if (value === "session" || value === "always") return value;
  if (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 2 &&
    value.every((entry) => entry === "session" || entry === "always")
  ) {
    return [...value];
  }
  return undefined;
}

function normalizeToolParamsDisplay(value: unknown): Array<{
  readonly name: string;
  readonly displayName: string;
  readonly value: JsonValue;
}> | null {
  if (!Array.isArray(value)) return null;
  const normalized: Array<{
    readonly name: string;
    readonly displayName: string;
    readonly value: JsonValue;
  }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (entry.display_name !== undefined && typeof entry.display_name !== "string") {
      return null;
    }
    const displayName = entry.display_name === undefined ? name : entry.display_name.trim();
    if (!name || !displayName || !isJsonValue(entry.value)) return null;
    normalized.push({ name, displayName, value: entry.value });
  }
  return normalized;
}
function normalizeConnectorAuthFailure(value: JsonValue | null):
  | Extract<
      CodexCanonicalMcpElicitation,
      {
        kind: "connectorAuth";
      }
    >["connector"]
  | null {
  const meta = toJsonObject(value);
  const codexApps = toJsonObject(meta?._codex_apps);
  const failure = toJsonObject(codexApps?.connector_auth_failure);
  if (
    failure?.is_auth_failure !== true ||
    typeof failure.connector_id !== "string" ||
    typeof failure.connector_name !== "string" ||
    typeof failure.install_url !== "string" ||
    (failure.auth_reason !== undefined && typeof failure.auth_reason !== "string") ||
    (failure.link_id !== undefined && typeof failure.link_id !== "string") ||
    (failure.requested_scopes !== undefined &&
      (!Array.isArray(failure.requested_scopes) ||
        !failure.requested_scopes.every(
          (scope) => typeof scope === "string" && scope.trim().length > 0,
        )))
  ) {
    return null;
  }

  return {
    ...failure,
    is_auth_failure: true,
    connector_id: failure.connector_id,
    connector_name: failure.connector_name,
    install_url: failure.install_url,
    ...(typeof failure.auth_reason === "string" ? { auth_reason: failure.auth_reason } : {}),
    ...(typeof failure.link_id === "string" ? { link_id: failure.link_id } : {}),
    ...(isStringArray(failure.requested_scopes)
      ? {
          requested_scopes: failure.requested_scopes.map((scope) => scope.trim()),
        }
      : {}),
  };
}
function normalizeToolSuggestion(value: JsonValue | null):
  | Extract<
      CodexCanonicalMcpElicitation,
      {
        kind: "toolSuggestion";
      }
    >["suggestion"]
  | null {
  const meta = toJsonObject(value);
  if (
    meta?.codex_approval_kind !== "tool_suggestion" ||
    (meta.suggest_type !== "install" && meta.suggest_type !== "enable") ||
    typeof meta.suggest_reason !== "string" ||
    typeof meta.tool_id !== "string" ||
    typeof meta.tool_name !== "string" ||
    (meta.persist !== undefined && meta.persist !== "always") ||
    (meta.tool_type !== "connector" && meta.tool_type !== "plugin")
  ) {
    return null;
  }
  if (meta.tool_type === "connector" && typeof meta.install_url !== "string") {
    return null;
  }
  if (
    meta.tool_type === "plugin" &&
    meta.install_url !== undefined &&
    typeof meta.install_url !== "string"
  ) {
    return null;
  }
  if (
    meta.tool_type === "plugin" &&
    meta.remote_plugin_id !== undefined &&
    (typeof meta.remote_plugin_id !== "string" || meta.remote_plugin_id.trim().length === 0)
  ) {
    return null;
  }
  return {
    ...meta,
    ...(meta.tool_type === "plugin" && typeof meta.remote_plugin_id === "string"
      ? { remote_plugin_id: meta.remote_plugin_id.trim() }
      : {}),
  } as Extract<
    CodexCanonicalMcpElicitation,
    {
      kind: "toolSuggestion";
    }
  >["suggestion"];
}
function normalizeMcpToolCallApproval(value: JsonValue | null):
  | Extract<
      CodexCanonicalMcpElicitation,
      {
        kind: "mcpToolCall";
      }
    >["approval"]
  | null {
  const meta = toJsonObject(value);
  const toolParams = toJsonObject(meta?.tool_params);
  const persist = normalizePersist(meta?.persist);
  if (
    meta?.codex_approval_kind !== "mcp_tool_call" ||
    typeof meta.connector_id !== "string" ||
    toolParams === null ||
    (meta.codex_request_type !== undefined && meta.codex_request_type !== "approval_request") ||
    (meta.connector_name !== undefined && typeof meta.connector_name !== "string") ||
    (meta.tool_name !== undefined && typeof meta.tool_name !== "string") ||
    (meta.tool_title !== undefined && typeof meta.tool_title !== "string") ||
    (meta.persist !== undefined && persist === undefined)
  ) {
    return null;
  }
  return {
    ...meta,
    codex_approval_kind: "mcp_tool_call",
    connector_id: meta.connector_id,
    tool_params: toolParams,
    ...(persist === undefined ? {} : { persist }),
  } as Extract<
    CodexCanonicalMcpElicitation,
    {
      kind: "mcpToolCall";
    }
  >["approval"];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, JsonValue | undefined>,
  key: string,
): boolean {
  if (source[key] === undefined) return true;
  if (typeof source[key] !== "string") return false;
  target[key] = source[key];
  return true;
}

function copyOptionalFiniteNumber(
  source: Record<string, unknown>,
  target: Record<string, JsonValue | undefined>,
  key: string,
): boolean {
  if (source[key] === undefined) return true;
  if (typeof source[key] !== "number" || !Number.isFinite(source[key])) return false;
  target[key] = source[key];
  return true;
}

function normalizeOpenAIPrimitiveSchema(value: unknown): JsonValue | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const output: Record<string, JsonValue | undefined> = { type: value.type };
  if (
    !copyOptionalString(value, output, "title") ||
    !copyOptionalString(value, output, "description")
  ) {
    return null;
  }

  if (value.type === "boolean") {
    if (value.default !== undefined && typeof value.default !== "boolean") return null;
    if (typeof value.default === "boolean") output.default = value.default;
    return output;
  }

  if (value.type === "number" || value.type === "integer") {
    if (
      !copyOptionalFiniteNumber(value, output, "minimum") ||
      !copyOptionalFiniteNumber(value, output, "maximum") ||
      !copyOptionalFiniteNumber(value, output, "default")
    ) {
      return null;
    }
    return output;
  }

  if (value.type === "array") {
    if (
      !copyOptionalFiniteNumber(value, output, "minItems") ||
      !copyOptionalFiniteNumber(value, output, "maxItems") ||
      (value.default !== undefined && !isStringArray(value.default))
    ) {
      return null;
    }
    const items = value.items;
    if (!isRecord(items)) return null;
    if (items.type === "string" && isStringArray(items.enum)) {
      output.items = { type: "string", enum: [...items.enum] };
    } else if (Array.isArray(items.anyOf)) {
      const anyOf: Array<{
        const: string;
        title: string;
      }> = [];
      for (const entry of items.anyOf) {
        if (
          !isRecord(entry) ||
          typeof entry.const !== "string" ||
          typeof entry.title !== "string"
        ) {
          return null;
        }
        anyOf.push({ const: entry.const, title: entry.title });
      }
      output.items = { anyOf };
    } else {
      return null;
    }
    if (isStringArray(value.default)) output.default = [...value.default];
    return output;
  }

  if (value.type !== "string") return null;
  if (value.default !== undefined && typeof value.default !== "string") return null;
  if (isStringArray(value.enum)) {
    output.enum = [...value.enum];
    if (isStringArray(value.enumNames)) output.enumNames = [...value.enumNames];
    if (typeof value.default === "string") output.default = value.default;
    return output;
  }
  if (Array.isArray(value.oneOf)) {
    const oneOf: Array<{
      const: string;
      title: string;
    }> = [];
    for (const entry of value.oneOf) {
      if (!isRecord(entry) || typeof entry.const !== "string" || typeof entry.title !== "string") {
        break;
      }
      oneOf.push({ const: entry.const, title: entry.title });
    }
    if (oneOf.length === value.oneOf.length) {
      output.oneOf = oneOf;
      if (typeof value.default === "string") output.default = value.default;
      return output;
    }
  }
  if (
    !copyOptionalFiniteNumber(value, output, "minLength") ||
    !copyOptionalFiniteNumber(value, output, "maxLength")
  ) {
    return null;
  }
  if (
    value.format !== undefined &&
    value.format !== "email" &&
    value.format !== "uri" &&
    value.format !== "date" &&
    value.format !== "date-time"
  ) {
    return null;
  }
  if (typeof value.format === "string") output.format = value.format;
  if (typeof value.default === "string") output.default = value.default;
  return output;
}

function normalizeOpenAIImagePickerSchema(value: unknown): JsonValue | null {
  if (!isRecord(value) || value.type !== "openai/imagePicker") return null;
  const allowedKeys = new Set(["title", "description", "type", "items"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (
    (value.title !== undefined && typeof value.title !== "string") ||
    (value.description !== undefined && typeof value.description !== "string") ||
    !Array.isArray(value.items) ||
    value.items.length === 0
  ) {
    return null;
  }
  const ids = new Set<string>();
  const items: Array<{
    id: string;
    title: string;
    image: string;
  }> = [];
  const dataImagePattern = /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/]+={0,2}$/;
  for (const entry of value.items) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => !["id", "title", "image"].includes(key)) ||
      typeof entry.id !== "string" ||
      entry.id.trim().length === 0 ||
      typeof entry.title !== "string" ||
      entry.title.trim().length === 0 ||
      typeof entry.image !== "string" ||
      !dataImagePattern.test(entry.image) ||
      // `DW` validates via `trim()` but preserves the original scalar. The
      // subsequent Set therefore compares the preserved IDs, not trimmed IDs.
      ids.has(entry.id)
    ) {
      return null;
    }
    ids.add(entry.id);
    items.push({ id: entry.id, title: entry.title, image: entry.image });
  }
  return {
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    type: "openai/imagePicker",
    items,
  };
}

function normalizeOpenAIFormSchema(value: JsonValue): JsonValue | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set(["$schema", "type", "properties", "required"]);
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    value.type !== "object" ||
    !isRecord(value.properties) ||
    (value.$schema !== undefined && typeof value.$schema !== "string") ||
    (value.required !== undefined && !isStringArray(value.required))
  ) {
    return null;
  }
  const properties: Record<string, JsonValue | undefined> = {};
  for (const [name, schema] of Object.entries(value.properties)) {
    const normalized =
      normalizeOpenAIImagePickerSchema(schema) ?? normalizeOpenAIPrimitiveSchema(schema);
    if (normalized === null) return null;
    properties[name] = normalized;
  }
  return {
    ...(typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
    type: "object",
    properties,
    ...(isStringArray(value.required) ? { required: [...value.required] } : {}),
  };
}

function withoutGenericMcpControlFields(value: JsonValue | null): JsonValue {
  const meta = toJsonObject(value);
  if (!meta) return value;
  const metadata = { ...meta };
  delete metadata.persist;
  delete metadata.tool_params;
  delete metadata.tool_params_display;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function isGenericMcpApproval(
  params: Extract<
    McpServerElicitationRequestParams,
    {
      mode: "form";
    }
  >,
): boolean {
  const meta = toJsonObject(params._meta);
  if (meta?.codex_approval_kind === "mcp_tool_call") return true;
  if (params.serverName !== "browser" && params.serverName !== "browser-use") {
    return false;
  }
  if (Object.keys(params.requestedSchema.properties).length !== 0) return false;
  if (normalizePersist(meta?.persist) === undefined) return false;
  return typeof meta?.origin === "string" && meta.origin.trim().length > 0;
}

/** Structural equivalent of 30751 `OW`; returns null only for unrenderable input. */
export function normalizeCodexCanonicalMcpElicitation(
  params: McpServerElicitationRequestParams,
  isOpenAIFormElicitationsEnabled = true,
): CodexCanonicalMcpElicitation | null {
  if (params.mode === "openai/userVerification") return null;
  const displayMeta = normalizeMcpMeta(params._meta);
  if (params.mode === "url") {
    const url = parseHttpsUrl(params.url);
    if (!url) return null;
    if (params.serverName !== "codex_apps") {
      return {
        ...displayMeta,
        kind: "urlAction",
        message: params.message,
        serverName: params.serverName,
        url: url.toString(),
      };
    }
    const connector = normalizeConnectorAuthFailure(params._meta);
    if (!connector || !isChatGptHostname(url.hostname)) return null;
    const installUrl = parseHttpsUrl(connector.install_url);
    return {
      ...displayMeta,
      kind: "connectorAuth",
      message: params.message,
      url: url.toString(),
      connector: {
        ...connector,
        install_url:
          installUrl && isChatGptHostname(installUrl.hostname)
            ? installUrl.toString()
            : url.toString(),
      },
    };
  }

  if (params.mode === "openai/form") {
    const schema = isOpenAIFormElicitationsEnabled
      ? normalizeOpenAIFormSchema(params.requestedSchema)
      : null;
    return schema === null
      ? { kind: "unsupportedOpenAIForm", serverName: params.serverName }
      : {
          ...displayMeta,
          kind: "openaiForm",
          message: params.message,
          serverName: params.serverName,
          schema,
        };
  }

  if (params.mode !== "form") return null;

  const suggestion = normalizeToolSuggestion(params._meta);
  if (suggestion) {
    return { ...displayMeta, kind: "toolSuggestion", suggestion };
  }
  const approval = normalizeMcpToolCallApproval(params._meta);
  if (approval) {
    const toolParamsDisplay = normalizeToolParamsDisplay(
      toJsonObject(params._meta)?.tool_params_display,
    );
    return {
      ...displayMeta,
      kind: "mcpToolCall",
      message: params.message,
      approval,
      toolParamsDisplay: toolParamsDisplay ?? undefined,
    };
  }

  const meta = toJsonObject(params._meta);
  const persist = normalizePersist(meta?.persist);
  const appName =
    params.serverName === "computer-use" &&
    Array.isArray(persist) &&
    persist.includes("always") &&
    Object.keys(params.requestedSchema.properties).length === 0
      ? /^Allow (?:Codex|ChatGPT) to use (.+)\?$/.exec(params.message)?.[1]?.trim()
      : null;
  if (appName) {
    return {
      ...displayMeta,
      kind: "mcpToolCall",
      message: params.message,
      approval: {
        codex_approval_kind: "mcp_tool_call",
        connector_id: "computer-use",
        connector_name: "Computer Use",
        persist,
        tool_params: { app: appName },
      },
      toolParamsDisplay: [{ name: "app", displayName: "App", value: appName }],
    };
  }

  if (isGenericMcpApproval(params)) {
    const toolParamsDisplay = normalizeToolParamsDisplay(meta?.tool_params_display);
    return {
      ...displayMeta,
      kind: "generic",
      message: params.message,
      serverName: params.serverName,
      metadata: withoutGenericMcpControlFields(params._meta),
      persist,
      requestedSchema: params.requestedSchema,
      toolParams: toJsonObject(meta?.tool_params),
      toolParamsDisplay: toolParamsDisplay ?? undefined,
    };
  }

  return {
    ...displayMeta,
    kind: "formElicitation",
    message: params.message,
    serverName: params.serverName,
    schema: params.requestedSchema,
  };
}

export function shouldAutomaticallyAcceptCodexMcpElicitation(
  state: CodexCanonicalConversationState,
  request: McpElicitationRequest,
): boolean {
  const elicitation = normalizeCodexCanonicalMcpElicitation(request.params, true);
  if (!elicitation) return false;
  const turn = request.params.turnId
    ? residentConversationTurns(state).find(
        (candidate) => candidate.turnId === request.params.turnId,
      )
    : null;
  if (!turn) return false;

  const browserOriginAccess =
    (request.params.serverName === "browser" || request.params.serverName === "browser-use") &&
    elicitation.kind === "mcpToolCall" &&
    elicitation.approval.connector_id === "browser-use" &&
    (elicitation.approval.tool_name === "access_browser_origin" ||
      elicitation.approval.tool_name === "access_browser_origin_with_raw_cdp") &&
    turn.params.approvalPolicy === "never" &&
    turn.params.sandboxPolicy?.type === "dangerFullAccess";
  if (browserOriginAccess) return true;

  return (
    request.params.serverName === "messages" &&
    elicitation.kind === "generic" &&
    request.params.mode === "form" &&
    Object.keys(request.params.requestedSchema.properties).length === 0 &&
    turn.params.approvalsReviewer === "user" &&
    turn.items.some(
      (item) =>
        item.type === "mcpToolCall" &&
        item.pluginId === "messages@openai-bundled" &&
        item.server === "messages" &&
        item.tool === "send_message" &&
        item.status === "inProgress",
    )
  );
}

export function isCodexCanonicalPrivateServerRequest(
  request: CodexCanonicalServerRequest,
): request is CodexCanonicalServerRequestExtension {
  return (
    request.method === "item/tool/requestOptionPicker" ||
    request.method === "item/tool/requestSetupCodexContextPicker" ||
    request.method === "item/plan/requestImplementation"
  );
}

export function classifyCodexCanonicalServerRequest(
  request: CodexCanonicalServerRequest,
): CodexServerRequestClassification {
  if (isCodexCanonicalPrivateServerRequest(request)) {
    return { source: "private", behavior: "store" };
  }
  switch (request.method) {
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput":
    case "mcpServer/elicitation/request":
      return { source: "generated", behavior: "storeAndSynthesize" };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { source: "generated", behavior: "store" };
    case "item/tool/call":
      return { source: "generated", behavior: "specialDynamic" };
    case "currentTime/read":
      return { source: "generated", behavior: "respond" };
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case "applyPatchApproval":
    case "execCommandApproval":
      return { source: "generated", behavior: "ignore" };
  }
}

function buildPermissionSynthetic(
  requestId: RequestId,
  params: PermissionsRequestApprovalParams,
  completed: boolean,
  response: PermissionsRequestApprovalResponse | null = null,
): Extract<
  CodexCanonicalRequestSyntheticItem,
  {
    type: "permissionRequest";
  }
> {
  return {
    id: `permission-request-${requestId}`,
    type: "permissionRequest",
    requestId,
    turnId: params.turnId,
    reason: params.reason,
    permissions: params.permissions,
    completed,
    response,
  };
}

function buildUserInputSynthetic(
  requestId: RequestId,
  params: ToolRequestUserInputParams,
  completed: boolean,
  answers: CodexCanonicalUserInputAnswers = {},
): Extract<
  CodexCanonicalRequestSyntheticItem,
  {
    type: "userInputResponse";
  }
> {
  return {
    id: `user-input-response-${requestId}`,
    type: "userInputResponse",
    requestId,
    turnId: params.turnId,
    questions: params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: (question.options ?? []).map((option) => ({
        description: option.description,
        label: option.label,
      })),
    })),
    answers,
    completed,
  };
}

function buildMcpSynthetic(
  requestId: RequestId,
  params: McpServerElicitationRequestParams,
  completed: boolean,
  elicitation: CodexCanonicalMcpElicitation,
  action: McpServerElicitationAction | null = null,
): Extract<
  CodexCanonicalRequestSyntheticItem,
  {
    type: "mcpServerElicitation";
  }
> {
  return {
    id: `mcp-server-elicitation-${requestId}`,
    type: "mcpServerElicitation",
    requestId,
    turnId: params.turnId ?? "",
    elicitation,
    completed,
    action,
  };
}

function requestThreadId(request: CodexCanonicalServerRequest): string | null {
  if (request.method === "currentTime/read") return null;
  return "threadId" in request.params && typeof request.params.threadId === "string"
    ? request.params.threadId
    : null;
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isOption(value: unknown): boolean {
  if (!isRecord(value) || typeof value.label !== "string") return false;
  return (
    value.description === undefined ||
    value.description === null ||
    typeof value.description === "string"
  );
}

function isValidOptionPickerArguments(value: JsonValue): boolean {
  if (!isRecord(value) || typeof value.question !== "string") return false;
  if (!Array.isArray(value.options) || !value.options.every(isOption)) return false;
  return (
    (value.allowMultiple === undefined || typeof value.allowMultiple === "boolean") &&
    (value.submitLabel === undefined ||
      value.submitLabel === null ||
      typeof value.submitLabel === "string") &&
    (value.skipLabel === undefined ||
      value.skipLabel === null ||
      typeof value.skipLabel === "string")
  );
}

function isValidOnboardingArguments(value: JsonValue): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["questions"])) return false;
  if (!Array.isArray(value.questions)) return false;
  if (value.questions.length < 1 || value.questions.length > 3) return false;
  return value.questions.every(
    (question) =>
      isRecord(question) &&
      hasOnlyKeys(question, ["id", "header", "question", "options"]) &&
      typeof question.id === "string" &&
      (question.header === undefined ||
        question.header === null ||
        typeof question.header === "string") &&
      typeof question.question === "string" &&
      Array.isArray(question.options) &&
      question.options.length >= 2 &&
      question.options.every(isOption),
  );
}

function parseSetupStep(value: JsonValue): "role" | "task" | "context" | "complete" | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["step"])) return null;
  return value.step === "role" ||
    value.step === "task" ||
    value.step === "context" ||
    value.step === "complete"
    ? value.step
    : null;
}

function invalidDynamicToolCallResponse(tool: string): DynamicToolCallResponse {
  return {
    contentItems: [
      {
        type: "inputText",
        text: `${tool} received invalid arguments.`,
      },
    ],
    success: false,
  };
}

function emptyRawResult(
  state: CodexServerRequestRawState,
  disposition: CodexServerRequestLifecycleDisposition,
  effects: readonly CodexServerRequestLifecycleEffect[] = [],
): CodexServerRequestRawLifecycleResult {
  return {
    state,
    effects,
    disposition,
    stateChanged: false,
    turnMutations: [],
    selectedRequests: [],
    selectedRequestIds: [],
  };
}

function changedRawResult(
  state: CodexServerRequestRawState,
  disposition: CodexServerRequestLifecycleDisposition,
  options: {
    readonly effects?: readonly CodexServerRequestLifecycleEffect[];
    readonly turnMutations?: readonly CodexServerRequestRawTurnMutation[];
    readonly selectedRequests?: readonly CodexCanonicalServerRequest[];
  } = {},
): CodexServerRequestRawLifecycleResult {
  const selectedRequests = options.selectedRequests ?? [];
  return {
    state,
    effects: options.effects ?? [],
    disposition,
    stateChanged: true,
    turnMutations: options.turnMutations ?? [],
    selectedRequests,
    selectedRequestIds: selectedRequests.map((request) => request.id),
  };
}

function appendRawStoredRequest(
  state: CodexServerRequestRawState,
  request: CodexCanonicalServerRequest,
): CodexServerRequestRawState {
  const requests =
    request.method === "item/plan/requestImplementation"
      ? state.requests.filter(
          (candidate) =>
            candidate.method !== "item/plan/requestImplementation" ||
            candidate.params.turnId !== request.params.turnId,
        )
      : state.requests;
  return {
    ...state,
    requests: [...requests, request],
    hasUnreadTurn: true,
  };
}

function findLastRawTurnIndexById(
  turns: readonly CodexServerRequestRawTurnState[],
  turnId: string,
): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.turnId === turnId) return index;
  }
  return -1;
}

function resolveRawSyntheticTurn(
  turns: readonly CodexServerRequestRawTurnState[],
  turnId: string,
  context: CodexServerRequestLifecycleContext,
): {
  readonly turns: readonly CodexServerRequestRawTurnState[];
  readonly index: number;
} | null {
  const latestIndex = turns.length - 1;
  const latest = turns[latestIndex];
  if (!latest) return null;
  if (!turnId) return { turns, index: latestIndex };
  const exactIndex = findLastRawTurnIndexById(turns, turnId);
  if (exactIndex >= 0) return { turns, index: exactIndex };
  if (
    turns.length !== 1 ||
    latest.turnId !== null ||
    latest.status !== "completed" ||
    latest.hasError ||
    latest.items.length !== 0
  ) {
    return null;
  }
  return {
    turns: [
      {
        ...latest,
        turnId,
        status: "inProgress",
        turnStartedAtMs: latest.turnStartedAtMs ?? context.now(),
      },
    ],
    index: 0,
  };
}

function rawItemId(value: unknown): string | null {
  return isRecord(value) && typeof value.id === "string" ? value.id : null;
}

function upsertRawRequestSynthetic(
  state: CodexServerRequestRawState,
  turnId: string,
  syntheticItem: CodexCanonicalRequestSyntheticItem,
  context: CodexServerRequestLifecycleContext,
): {
  readonly state: CodexServerRequestRawState;
  readonly mutation: CodexServerRequestRawTurnMutation | null;
} {
  const resolved = resolveRawSyntheticTurn(state.turns, turnId, context);
  if (!resolved) return { state, mutation: null };
  const sourceTurn = resolved.turns[resolved.index]!;
  const itemIndex = sourceTurn.items.findIndex(
    (candidate) => rawItemId(candidate) === syntheticItem.id,
  );
  const items = [...sourceTurn.items];
  if (itemIndex >= 0) {
    items[itemIndex] = syntheticItem;
  } else {
    items.push(syntheticItem);
  }
  const turn: CodexServerRequestRawTurnState = {
    ...sourceTurn,
    items,
    hookRuns: sourceTurn.hookRuns ?? [],
  };
  const turns = [...resolved.turns];
  turns[resolved.index] = turn;
  return {
    state: { ...state, turns },
    mutation: { turnIndex: resolved.index, turn, syntheticItem },
  };
}

function storeRawSyntheticRequest(
  state: CodexServerRequestRawState,
  request: CodexCanonicalServerRequest,
  turnId: string,
  syntheticItem: CodexCanonicalRequestSyntheticItem | null,
  context: CodexServerRequestLifecycleContext,
): {
  readonly state: CodexServerRequestRawState;
  readonly turnMutations: readonly CodexServerRequestRawTurnMutation[];
} {
  const stored = appendRawStoredRequest(state, request);
  if (!syntheticItem) return { state: stored, turnMutations: [] };
  const upserted = upsertRawRequestSynthetic(stored, turnId, syntheticItem, context);
  return {
    state: upserted.state,
    turnMutations: upserted.mutation ? [upserted.mutation] : [],
  };
}

function reduceRawDynamicToolCallRequest(
  state: CodexServerRequestRawState,
  request: DynamicToolCallRequest,
): CodexServerRequestRawLifecycleResult {
  const { tool, arguments: args } = request.params;
  const isCodexAppTool = (candidate: string): boolean =>
    hasCodexDynamicToolIdentity(request.params, {
      namespace: CODEX_APP_TOOL_NAMESPACE,
      tool: candidate,
    });
  if (isCodexAppTool("setup_codex_step")) {
    const step = parseSetupStep(args);
    if (step === null) {
      return emptyRawResult(state, "responded", [
        {
          type: "respond",
          method: request.method,
          requestId: request.id,
          response: invalidDynamicToolCallResponse(tool),
        },
      ]);
    }
    if (step !== "complete") {
      return changedRawResult(appendRawStoredRequest(state, request), "stored");
    }
  }

  if (
    isCodexAppTool("request_option_picker") ||
    isCodexAppTool("request_onboarding_input") ||
    isCodexAppTool("setup_codex_context_picker")
  ) {
    const valid = isCodexAppTool("request_option_picker")
      ? isValidOptionPickerArguments(args)
      : isCodexAppTool("request_onboarding_input")
        ? isValidOnboardingArguments(args)
        : true;
    if (!valid) {
      return emptyRawResult(state, "responded", [
        {
          type: "respond",
          method: request.method,
          requestId: request.id,
          response: invalidDynamicToolCallResponse(tool),
        },
      ]);
    }
    return changedRawResult(appendRawStoredRequest(state, request), "stored");
  }

  return emptyRawResult(state, "dispatched", [{ type: "dispatchDynamicToolCall", request }]);
}

export function reduceCodexServerRequestRawState(
  state: CodexServerRequestRawState,
  request: CodexCanonicalServerRequest,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestRawLifecycleResult {
  const threadId = requestThreadId(request);
  if (threadId !== null && threadId !== state.threadId) {
    return emptyRawResult(state, "foreignConversation");
  }

  switch (request.method) {
    case "item/permissions/requestApproval": {
      const stored = storeRawSyntheticRequest(
        state,
        request,
        request.params.turnId,
        buildPermissionSynthetic(request.id, request.params, false),
        context,
      );
      return changedRawResult(stored.state, "stored", {
        turnMutations: stored.turnMutations,
      });
    }
    case "item/fileChange/requestApproval":
      return changedRawResult(appendRawStoredRequest(state, request), "stored", {
        effects: [
          { type: "refreshFileApprovalContext", threadId: request.params.threadId },
          { type: "approvalRequestReceived", request },
        ],
      });
    case "item/commandExecution/requestApproval":
      return changedRawResult(appendRawStoredRequest(state, request), "stored", {
        effects: [{ type: "approvalRequestReceived", request }],
      });
    case "item/tool/requestUserInput": {
      const stored = storeRawSyntheticRequest(
        state,
        request,
        request.params.turnId,
        buildUserInputSynthetic(request.id, request.params, false),
        context,
      );
      return changedRawResult(stored.state, "stored", {
        effects: [{ type: "userInputRequestReceived", request }],
        turnMutations: stored.turnMutations,
      });
    }
    case "item/tool/requestOptionPicker":
    case "item/plan/requestImplementation":
      return changedRawResult(appendRawStoredRequest(state, request), "stored");
    case "item/tool/requestSetupCodexContextPicker":
      return emptyRawResult(state, "responded", [
        {
          type: "respond",
          method: request.method,
          requestId: request.id,
          response: { action: "dismiss", selectedSources: [] },
        },
      ]);
    case "item/tool/call":
      return reduceRawDynamicToolCallRequest(state, request);
    case "mcpServer/elicitation/request": {
      const elicitation = normalizeCodexCanonicalMcpElicitation(
        request.params,
        context.isOpenAIFormElicitationsEnabled ?? true,
      );
      if (!elicitation) {
        return emptyRawResult(state, "responded", [
          {
            type: "respond",
            method: request.method,
            requestId: request.id,
            response: { action: "decline", content: null, _meta: null },
          },
        ]);
      }
      const turnId = request.params.turnId;
      const stored = storeRawSyntheticRequest(
        state,
        request,
        turnId ?? "",
        turnId ? buildMcpSynthetic(request.id, request.params, false, elicitation) : null,
        context,
      );
      return changedRawResult(stored.state, "stored", {
        turnMutations: stored.turnMutations,
      });
    }
    case "currentTime/read":
      return emptyRawResult(state, "responded", [
        {
          type: "respond",
          method: request.method,
          requestId: request.id,
          response: { currentTimeAt: Math.floor(context.now() / 1000) },
        },
      ]);
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case "applyPatchApproval":
    case "execCommandApproval":
      return emptyRawResult(state, "ignored");
  }
}

function completeRawResolvedRequestSynthetic(
  state: CodexServerRequestRawState,
  request: CodexCanonicalServerRequest | undefined,
  context: CodexServerRequestLifecycleContext,
): {
  readonly state: CodexServerRequestRawState;
  readonly turnMutations: readonly CodexServerRequestRawTurnMutation[];
} {
  if (!request) return { state, turnMutations: [] };
  let upserted: ReturnType<typeof upsertRawRequestSynthetic> | null = null;
  switch (request.method) {
    case "item/permissions/requestApproval":
      upserted = upsertRawRequestSynthetic(
        state,
        request.params.turnId,
        buildPermissionSynthetic(request.id, request.params, true),
        context,
      );
      break;
    case "item/tool/requestUserInput":
      upserted = upsertRawRequestSynthetic(
        state,
        request.params.turnId,
        buildUserInputSynthetic(request.id, request.params, true),
        context,
      );
      break;
    case "mcpServer/elicitation/request": {
      const turnId = request.params.turnId;
      const elicitation = normalizeCodexCanonicalMcpElicitation(request.params);
      if (!turnId || !elicitation) break;
      upserted = upsertRawRequestSynthetic(
        state,
        turnId,
        buildMcpSynthetic(request.id, request.params, true, elicitation),
        context,
      );
      break;
    }
    default:
      break;
  }
  return {
    state: upserted?.state ?? state,
    turnMutations: upserted?.mutation ? [upserted.mutation] : [],
  };
}

export function reduceCodexServerRequestResolvedRawState(
  state: CodexServerRequestRawState,
  notification: CodexServerRequestResolvedNotification,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestRawLifecycleResult {
  if (notification.params.threadId !== state.threadId) {
    return emptyRawResult(state, "foreignConversation");
  }
  const requestId = notification.params.requestId;
  const firstRequest = state.requests.find((request) => request.id === requestId);
  const completed = completeRawResolvedRequestSynthetic(state, firstRequest, context);
  return changedRawResult(
    removeCodexServerRequestsByIdRawState(completed.state, requestId),
    "resolved",
    {
      turnMutations: completed.turnMutations,
      selectedRequests: firstRequest ? [firstRequest] : [],
    },
  );
}

export function removeCodexServerRequestsByIdRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
): CodexServerRequestRawState {
  return {
    ...state,
    requests: state.requests.filter((request) => request.id !== requestId),
  };
}

function removeSelectedRequestIds(
  state: CodexServerRequestRawState,
  selectedRequests: readonly CodexCanonicalServerRequest[],
): CodexServerRequestRawState {
  if (selectedRequests.length === 0) return state;
  const ids = selectedRequests.map((request) => request.id);
  return {
    ...state,
    requests: state.requests.filter(
      (request) => !ids.some((requestId) => request.id === requestId),
    ),
  };
}

function selectedRawReplyResult(
  state: CodexServerRequestRawState,
  selectedRequests: readonly CodexCanonicalServerRequest[],
  turnMutations: readonly CodexServerRequestRawTurnMutation[] = [],
): CodexServerRequestRawLifecycleResult {
  if (selectedRequests.length === 0) return emptyRawResult(state, "ignored");
  return changedRawResult(removeSelectedRequestIds(state, selectedRequests), "resolved", {
    selectedRequests,
    turnMutations,
  });
}

/** Exact `F3e`: ordinary replies ignore local plan requests during lookup. */
function findFirstOrdinaryReplyRequest(
  requests: readonly CodexCanonicalServerRequest[],
  requestId: RequestId,
): CodexCanonicalServerRequest | undefined {
  return requests.find(
    (request) => request.id === requestId && request.method !== "item/plan/requestImplementation",
  );
}

export function reduceCodexServerRequestApprovalResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
  expectedMethod: CodexApprovalRequestMethod,
): CodexServerRequestRawLifecycleResult {
  const request = findFirstOrdinaryReplyRequest(state.requests, requestId);
  if (request?.method !== expectedMethod) {
    return emptyRawResult(state, "ignored");
  }
  return selectedRawReplyResult(state, [request]);
}

export function reduceCodexServerRequestPermissionResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
  response: PermissionsRequestApprovalResponse,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestRawLifecycleResult {
  const request = findFirstOrdinaryReplyRequest(state.requests, requestId);
  if (request?.method !== "item/permissions/requestApproval") {
    return emptyRawResult(state, "ignored");
  }
  const upserted = upsertRawRequestSynthetic(
    state,
    request.params.turnId,
    buildPermissionSynthetic(request.id, request.params, true, response),
    context,
  );
  return selectedRawReplyResult(
    upserted.state,
    [request],
    upserted.mutation ? [upserted.mutation] : [],
  );
}

function normalizeUserInputAnswers(
  answers: Readonly<Record<string, readonly string[] | undefined>>,
): CodexCanonicalUserInputAnswers {
  const normalized: Record<string, readonly string[]> = {};
  for (const [questionId, values] of Object.entries(answers)) {
    if (values !== undefined) normalized[questionId] = [...values];
  }
  return normalized;
}

export function reduceCodexServerRequestUserInputResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
  answers: Readonly<Record<string, readonly string[] | undefined>>,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestRawLifecycleResult {
  const request = findFirstOrdinaryReplyRequest(state.requests, requestId);
  if (request?.method !== "item/tool/requestUserInput") {
    return emptyRawResult(state, "ignored");
  }
  const upserted = upsertRawRequestSynthetic(
    state,
    request.params.turnId,
    buildUserInputSynthetic(request.id, request.params, true, normalizeUserInputAnswers(answers)),
    context,
  );
  return selectedRawReplyResult(
    upserted.state,
    [request],
    upserted.mutation ? [upserted.mutation] : [],
  );
}

function isStoredDynamicToolRequest(
  request: CodexCanonicalServerRequest | undefined,
  tool: "request_onboarding_input" | "setup_codex_step",
): request is DynamicToolCallRequest {
  return (
    request?.method === "item/tool/call" &&
    hasCodexDynamicToolIdentity(request.params, {
      namespace: CODEX_APP_TOOL_NAMESPACE,
      tool,
    })
  );
}

export function reduceCodexServerRequestOnboardingInputResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
): CodexServerRequestRawLifecycleResult {
  const request = state.requests.find((candidate) => candidate.id === requestId);
  if (!isStoredDynamicToolRequest(request, "request_onboarding_input")) {
    return emptyRawResult(state, "ignored");
  }
  return selectedRawReplyResult(state, [request]);
}

export function reduceCodexServerRequestSetupCodexStepResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
  response: CodexCanonicalSetupCodexStepResponse,
): CodexServerRequestRawLifecycleResult {
  const request = state.requests.find((candidate) => candidate.id === requestId);
  if (!isStoredDynamicToolRequest(request, "setup_codex_step")) {
    return emptyRawResult(state, "ignored");
  }
  const requestStep = parseSetupStep(request.params.arguments);
  if (requestStep === "complete" || requestStep !== response.step) {
    return emptyRawResult(state, "ignored");
  }
  return selectedRawReplyResult(state, [request]);
}

function reduceCodexServerRequestStoredPickerResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
  expected: {
    readonly directMethod:
      | "item/tool/requestOptionPicker"
      | "item/tool/requestSetupCodexContextPicker";
    readonly dynamicTool: "request_option_picker" | "setup_codex_context_picker";
  },
): CodexServerRequestRawLifecycleResult {
  const request = state.requests.find((candidate) => candidate.id === requestId);
  const supported =
    request?.method === expected.directMethod ||
    (request?.method === "item/tool/call" &&
      hasCodexDynamicToolIdentity(request.params, {
        namespace: CODEX_APP_TOOL_NAMESPACE,
        tool: expected.dynamicTool,
      }));
  if (!request || !supported) return emptyRawResult(state, "ignored");
  return selectedRawReplyResult(state, [request]);
}

export function reduceCodexServerRequestOptionPickerResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
): CodexServerRequestRawLifecycleResult {
  return reduceCodexServerRequestStoredPickerResponseRawState(state, requestId, {
    directMethod: "item/tool/requestOptionPicker",
    dynamicTool: "request_option_picker",
  });
}

export function reduceCodexServerRequestSetupContextPickerResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
): CodexServerRequestRawLifecycleResult {
  return reduceCodexServerRequestStoredPickerResponseRawState(state, requestId, {
    directMethod: "item/tool/requestSetupCodexContextPicker",
    dynamicTool: "setup_codex_context_picker",
  });
}

function sameStringSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const leftSet = new Set(left ?? []);
  const rightSet = new Set(right ?? []);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function equivalentConnectorAuthRequests(
  request: McpElicitationRequest,
  requests: readonly CodexCanonicalServerRequest[],
): readonly McpElicitationRequest[] {
  const normalized = normalizeCodexCanonicalMcpElicitation(request.params);
  if (normalized?.kind !== "connectorAuth") return [request];
  return requests.flatMap((candidate) => {
    if (candidate.method !== "mcpServer/elicitation/request") return [];
    const other = normalizeCodexCanonicalMcpElicitation(candidate.params);
    if (other?.kind !== "connectorAuth") return [];
    return normalized.connector.connector_id === other.connector.connector_id &&
      normalized.connector.link_id === other.connector.link_id &&
      normalized.connector.auth_reason === other.connector.auth_reason &&
      sameStringSet(normalized.connector.requested_scopes, other.connector.requested_scopes)
      ? [candidate]
      : [];
  });
}

export function reduceCodexServerRequestMcpElicitationResponseRawState(
  state: CodexServerRequestRawState,
  requestId: RequestId,
  response: McpServerElicitationRequestResponse,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestRawLifecycleResult {
  const request = findFirstOrdinaryReplyRequest(state.requests, requestId);
  if (request?.method !== "mcpServer/elicitation/request") {
    return emptyRawResult(state, "ignored");
  }
  const selectedRequests =
    response.action === "accept"
      ? equivalentConnectorAuthRequests(request, state.requests)
      : [request];
  let nextState = state;
  const turnMutations: CodexServerRequestRawTurnMutation[] = [];
  for (const selected of selectedRequests) {
    const turnId = selected.params.turnId;
    const elicitation = normalizeCodexCanonicalMcpElicitation(selected.params);
    if (turnId && elicitation) {
      const upserted = upsertRawRequestSynthetic(
        nextState,
        turnId,
        buildMcpSynthetic(selected.id, selected.params, true, elicitation, response.action),
        context,
      );
      nextState = upserted.state;
      if (upserted.mutation) turnMutations.push(upserted.mutation);
    }
    nextState = {
      ...nextState,
      requests: nextState.requests.filter((candidate) => candidate.id !== selected.id),
    };
  }
  return changedRawResult(nextState, "resolved", {
    selectedRequests,
    turnMutations,
  });
}

function buildCanonicalRawRequestState(
  state: CodexCanonicalConversationState,
): CodexServerRequestRawState {
  return {
    threadId: state.id,
    turns: residentConversationTurns(state).map((turn) => ({
      turnId: turn.turnId,
      status: turn.status,
      hasError: turn.error !== null,
      items: turn.items,
      hookRuns: turn.hookRuns,
      turnStartedAtMs: turn.turnStartedAtMs,
    })),
    requests: state.requests,
    hasUnreadTurn: state.hasUnreadTurn,
  };
}

type RequestMutation = Omit<CodexServerRequestLifecycleResult, "state" | "stateChanged">;

function mutateCanonicalViaRaw(
  state: Draft<CodexCanonicalConversationState>,
  plan: (raw: CodexServerRequestRawState) => CodexServerRequestRawLifecycleResult,
): RequestMutation {
  const source = buildCanonicalRawRequestState(current(state));
  const operation = plan(source);
  for (const mutation of operation.turnMutations) {
    const entry = residentConversationTurnEntries(state)[mutation.turnIndex];
    const turn = entry ? conversationTurnDraft(state, entry.address) : null;
    if (!turn) continue;
    turn.turnId = mutation.turn.turnId;
    turn.status = mutation.turn.status;
    turn.turnStartedAtMs = mutation.turn.turnStartedAtMs ?? null;
    turn.hookRuns ??= [];
    const index = turn.items.findIndex((item) => item.id === mutation.syntheticItem.id);
    if (index < 0)
      turn.items.push(mutation.syntheticItem as Draft<CodexCanonicalRequestSyntheticItem>);
    else turn.items[index] = mutation.syntheticItem as Draft<CodexCanonicalRequestSyntheticItem>;
  }
  if (source.requests !== operation.state.requests) {
    Object.assign(state, { requests: operation.state.requests });
  }
  state.hasUnreadTurn = operation.state.hasUnreadTurn;
  return {
    effects: operation.effects,
    disposition: operation.disposition,
    turnMutations: operation.turnMutations,
    selectedRequests: operation.selectedRequests,
    selectedRequestIds: operation.selectedRequestIds,
  };
}

export function mutateCodexConversationServerRequest(
  state: Draft<CodexCanonicalConversationState>,
  request: CodexCanonicalServerRequest,
  context: CodexServerRequestLifecycleContext,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestRawState(raw, request, context),
  );
}

export function reduceCodexConversationServerRequest(
  state: CodexCanonicalConversationState,
  request: CodexCanonicalServerRequest,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationServerRequest(draft, request, context);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationServerRequestResolved(
  state: Draft<CodexCanonicalConversationState>,
  notification: CodexServerRequestResolvedNotification,
  context: CodexServerRequestLifecycleContext,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestResolvedRawState(raw, notification, context),
  );
}

export function reduceCodexConversationServerRequestResolved(
  state: CodexCanonicalConversationState,
  notification: CodexServerRequestResolvedNotification,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationServerRequestResolved(draft, notification, context);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationApprovalResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
  expectedMethod: CodexApprovalRequestMethod,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestApprovalResponseRawState(raw, requestId, expectedMethod),
  );
}

export function reduceCodexConversationApprovalResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
  expectedMethod: CodexApprovalRequestMethod,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationApprovalResponse(draft, requestId, expectedMethod);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationPermissionResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
  response: PermissionsRequestApprovalResponse,
  context: CodexServerRequestLifecycleContext,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestPermissionResponseRawState(raw, requestId, response, context),
  );
}

export function reduceCodexConversationPermissionResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
  response: PermissionsRequestApprovalResponse,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationPermissionResponse(draft, requestId, response, context);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationUserInputResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
  answers: Readonly<Record<string, readonly string[] | undefined>>,
  context: CodexServerRequestLifecycleContext,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestUserInputResponseRawState(raw, requestId, answers, context),
  );
}

export function reduceCodexConversationUserInputResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
  answers: Readonly<Record<string, readonly string[] | undefined>>,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationUserInputResponse(draft, requestId, answers, context);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationMcpElicitationResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
  response: McpServerElicitationRequestResponse,
  context: CodexServerRequestLifecycleContext,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestMcpElicitationResponseRawState(raw, requestId, response, context),
  );
}

export function reduceCodexConversationMcpElicitationResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
  response: McpServerElicitationRequestResponse,
  context: CodexServerRequestLifecycleContext,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationMcpElicitationResponse(draft, requestId, response, context);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationOnboardingInputResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestOnboardingInputResponseRawState(raw, requestId),
  );
}

export function reduceCodexConversationOnboardingInputResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationOnboardingInputResponse(draft, requestId);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationSetupCodexStepResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
  response: CodexCanonicalSetupCodexStepResponse,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestSetupCodexStepResponseRawState(raw, requestId, response),
  );
}

export function reduceCodexConversationSetupCodexStepResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
  response: CodexCanonicalSetupCodexStepResponse,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationSetupCodexStepResponse(draft, requestId, response);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationOptionPickerResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestOptionPickerResponseRawState(raw, requestId),
  );
}

export function reduceCodexConversationOptionPickerResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationOptionPickerResponse(draft, requestId);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function mutateCodexConversationSetupContextPickerResponse(
  state: Draft<CodexCanonicalConversationState>,
  requestId: RequestId,
): RequestMutation {
  return mutateCanonicalViaRaw(state, (raw) =>
    reduceCodexServerRequestSetupContextPickerResponseRawState(raw, requestId),
  );
}

export function reduceCodexConversationSetupContextPickerResponse(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
): CodexServerRequestLifecycleResult {
  let operation!: RequestMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationSetupContextPickerResponse(draft, requestId);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

/** Exact local `B4e` request half for adapters without canonical snapshots. */
export function completeCodexPlanImplementationRequestRawState(
  state: CodexServerRequestRawState,
  turnId: string,
): CodexServerRequestRawState {
  return {
    ...state,
    requests: state.requests.filter(
      (request) =>
        request.method !== "item/plan/requestImplementation" || request.params.turnId !== turnId,
    ),
  };
}

/** Exact turn-start request half: retain only the active turn's private plan request. */
export function applyCodexPlanImplementationTurnStartedRawState(
  state: CodexServerRequestRawState,
  activeTurnId: string,
): CodexServerRequestRawState {
  return {
    ...state,
    requests: state.requests.filter(
      (request) =>
        request.method !== "item/plan/requestImplementation" ||
        request.params.turnId === activeTurnId,
    ),
  };
}

/** Exact local `B4e` request half; plan-item completion stays with its owner. */
export function mutateCodexCanonicalPlanImplementationRequestCompletion(
  state: Draft<CodexCanonicalConversationState>,
  turnId: string,
): void {
  state.requests = state.requests.filter(
    (request) =>
      request.method !== "item/plan/requestImplementation" || request.params.turnId !== turnId,
  );
}
export function completeCodexCanonicalPlanImplementationRequest(
  state: CodexCanonicalConversationState,
  turnId: string,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexCanonicalPlanImplementationRequestCompletion(draft, turnId),
  );
}
export function mutateCodexCanonicalPlanImplementationCompletion(
  state: Draft<CodexCanonicalConversationState>,
  turnId: string,
): void {
  mutateCodexCanonicalPlanImplementationRequestCompletion(state, turnId);
  for (const entry of residentConversationTurnEntries(state)) {
    if (entry.turn.turnId !== turnId) continue;
    for (const item of conversationTurnDraft(state, entry.address)!.items) {
      if (item.type === "planImplementation" && "isCompleted" in item) item.isCompleted = true;
    }
  }
}
export function completeCodexCanonicalPlanImplementationState(
  state: CodexCanonicalConversationState,
  turnId: string,
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexCanonicalPlanImplementationCompletion(draft, turnId));
}
export function mutateCodexCanonicalPlanImplementationTurnStarted(
  state: Draft<CodexCanonicalConversationState>,
  activeTurnId: string,
): void {
  state.requests = state.requests.filter(
    (request) =>
      request.method !== "item/plan/requestImplementation" ||
      request.params.turnId === activeTurnId,
  );
}
export function applyCodexCanonicalPlanImplementationTurnStartedState(
  state: CodexCanonicalConversationState,
  activeTurnId: string,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexCanonicalPlanImplementationTurnStarted(draft, activeTurnId),
  );
}

/** Exact local `z4e` constructor for callers that own the private plan signal. */
export function createCodexCanonicalPlanImplementationRequest(
  threadId: string,
  turnId: string,
  planContent: string,
  requestId: RequestId,
): CodexCanonicalPlanImplementationRequest {
  return {
    method: "item/plan/requestImplementation",
    id: requestId,
    params: { threadId, turnId, planContent },
  };
}
