import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

const Field = Schema.Struct({
  default: Schema.optionalKey(Schema.Json),
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  enumNames: Schema.optionalKey(Schema.Array(Schema.String)),
  oneOf: Schema.optionalKey(
    Schema.Array(Schema.Struct({ const: Schema.String, title: Schema.optionalKey(Schema.String) })),
  ),
});
const Form = Schema.Struct({
  properties: Schema.Record(Schema.String, Field),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeForm = Schema.decodeUnknownOption(Form);
const decodeApprovalForm = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Form.fields,
    properties: Schema.optionalKey(Form.fields.properties),
  }),
);

type CodexMcpApprovalPayload = Exclude<
  CodexSchema.McpServerElicitationRequestParams,
  { readonly mode: "url" | "openai/userVerification" }
>;

/** Tool authorization is separate from connection and information prompts. */
export function isCodexMcpPermissionRequest(
  payload: CodexSchema.McpServerElicitationRequestParams,
): payload is CodexMcpApprovalPayload {
  return (
    payload.mode !== "url" &&
    payload.mode !== "openai/userVerification" &&
    typeof payload._meta === "object" &&
    payload._meta !== null &&
    Reflect.get(payload._meta, "codex_approval_kind") === "mcp_tool_call"
  );
}

/**
 * What a client that answers MCP servers itself does before asking anyone, as app-server does for
 * its own threads. Strict review needs an automatic reviewer, and such a client has none. Full
 * access has nobody to ask, so it accepts bare consent and declines forms that want an answer.
 */
export function codexMcpElicitationPolicy(
  payload: CodexSchema.McpServerElicitationRequestParams,
  input: { readonly fullAccess: boolean },
): "accept" | "decline" | "ask" {
  if (payload.mode === "url" || payload.mode === "openai/userVerification") return "decline";
  const strict =
    typeof payload._meta === "object" && payload._meta !== null
      ? Reflect.get(payload._meta, "codex_strict_auto_review")
      : undefined;
  if (strict !== undefined && strict !== false) return "decline";
  if (!input.fullAccess) return "ask";
  const form = decodeApprovalForm(payload.requestedSchema);
  return form._tag === "Some" && Object.keys(form.value.properties ?? {}).length === 0
    ? "accept"
    : "decline";
}

export function codexMcpElicitationQuestions(
  payload: CodexSchema.McpServerElicitationRequestParams,
): ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion> {
  if (payload.mode === "openai/userVerification") return [];
  if (payload.mode === "url")
    return [
      {
        id: "connection",
        header: "Connection",
        question: `${payload.message}\n${payload.url}`,
        options: [
          { label: "Done", description: "Connection completed" },
          { label: "Cancel", description: "Cancel connection" },
        ],
      },
    ];
  const form = decodeForm(payload.requestedSchema);
  if (form._tag === "None") return [];
  if (
    Object.values(form.value.properties).some(
      (field) =>
        field.type !== undefined &&
        !["string", "boolean", "number", "integer", "array"].includes(field.type),
    )
  )
    return [];
  return Object.entries(form.value.properties).map(([id, field]) => ({
    id,
    header: field.title?.trim() || "Question",
    question: field.description?.trim() || payload.message,
    options:
      field.oneOf?.map((option) => ({
        label: option.const,
        description: option.title ?? option.const,
      })) ??
      field.enum?.map((value, index) => ({
        label: value,
        description: field.enumNames?.[index] ?? value,
      })) ??
      (field.type === "boolean"
        ? [
            { label: "true", description: "Yes" },
            { label: "false", description: "No" },
          ]
        : []),
  }));
}

/** Encode only fields requested by the native server; malformed answers decline. */
export function codexMcpElicitationResponse(
  payload: CodexSchema.McpServerElicitationRequestParams,
  answers: ProviderUserInputAnswers,
): CodexSchema.McpServerElicitationRequestResponse {
  if (payload.mode === "openai/userVerification") return { action: "decline" };
  if (payload.mode === "url")
    return { action: answers.connection === "Done" ? "accept" : "cancel" };
  const form = decodeForm(payload.requestedSchema);
  if (form._tag === "None") return { action: "decline" };
  const content: Record<string, Schema.Json> = {};
  for (const [key, field] of Object.entries(form.value.properties)) {
    const value = answers[key];
    if (value === undefined) continue;
    if (field.type === "boolean") {
      if (value !== true && value !== false && value !== "true" && value !== "false")
        return { action: "decline" };
      content[key] = value === true || value === "true";
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "")
        return { action: "decline" };
      const number = Number(value);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number)))
        return { action: "decline" };
      content[key] = number;
      continue;
    }
    if (
      Array.isArray(value) &&
      field.type === "array" &&
      value.every((entry) => typeof entry === "string")
    ) {
      content[key] = value;
      continue;
    }
    if (typeof value !== "string") return { action: "decline" };
    const values = field.oneOf?.map((option) => option.const) ?? field.enum;
    if (values !== undefined && !values.includes(value)) return { action: "decline" };
    content[key] = value;
  }
  if (form.value.required?.some((key) => !Object.hasOwn(content, key)))
    return { action: "decline" };
  return { action: "accept", content };
}

const ApprovalMetadata = Schema.Struct({
  persist: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
});
const decodeApprovalMetadata = Schema.decodeUnknownOption(ApprovalMetadata);
const isSessionOption = (value: string) => value.toLowerCase().includes("session");
const isOnceOption = (value: string) =>
  /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i.test(
    value.trim(),
  );

function approvalFieldOptions(field: typeof Field.Type) {
  return (
    field.oneOf?.map((option) => ({ value: option.const, label: option.title })) ??
    field.enum?.map((value, index) => ({ value, label: field.enumNames?.[index] })) ??
    []
  );
}

/** Encode the provider's authorization form without turning arbitrary required fields into consent. */
export function codexMcpApprovalResponse(
  payload: CodexMcpApprovalPayload,
  decision: ProviderApprovalDecision,
): CodexSchema.McpServerElicitationRequestResponse {
  if (decision === "decline" || decision === "cancel") return { action: decision };
  const form = decodeApprovalForm(payload.requestedSchema);
  if (form._tag === "None") return { action: "decline" };
  const content: Record<string, Schema.Json> = {};
  for (const [key, field] of Object.entries(form.value.properties ?? {})) {
    const chosen = approvalFieldOptions(field).find((option) =>
      (decision === "acceptForSession" ? isSessionOption : isOnceOption)(option.value),
    );
    if (chosen !== undefined) content[key] = chosen.value;
    else if (field.type === "boolean" && /persist|always|session/i.test(key)) content[key] = false;
    else if (field.default !== undefined) content[key] = field.default;
  }
  if (form.value.required?.some((key) => !Object.hasOwn(content, key)))
    return { action: "decline" };
  return {
    action: "accept",
    content,
    ...(decision === "acceptForSession" ? { _meta: { persist: "session" } } : {}),
  };
}

export function codexMcpApprovalOptions(
  payload: CodexMcpApprovalPayload,
): ReadonlyArray<ProviderApprovalOption> {
  const metadata = decodeApprovalMetadata(payload._meta);
  const persist = metadata._tag === "Some" ? metadata.value.persist : undefined;
  const form = decodeApprovalForm(payload.requestedSchema);
  const choices =
    form._tag === "Some"
      ? Object.values(form.value.properties ?? {}).flatMap(approvalFieldOptions)
      : [];
  const sessionOption = choices.find((option) => isSessionOption(option.value));
  const onceOption = choices.find((option) => isOnceOption(option.value));
  const supportsSession =
    sessionOption !== undefined ||
    (typeof persist === "string" ? [persist] : (persist ?? [])).some(isSessionOption);
  return [
    ...(codexMcpApprovalResponse(payload, "accept").action === "accept"
      ? [{ decision: "accept" as const, label: onceOption?.label || "Approve once" }]
      : []),
    ...(supportsSession && codexMcpApprovalResponse(payload, "acceptForSession").action === "accept"
      ? [
          {
            decision: "acceptForSession" as const,
            label: sessionOption?.label || "Allow for this chat",
          },
        ]
      : []),
    { decision: "decline", label: "Decline" },
    { decision: "cancel", label: "Cancel" },
  ];
}
