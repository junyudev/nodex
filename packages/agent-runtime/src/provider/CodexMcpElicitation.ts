import type { ProviderUserInputAnswers } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

const Field = Schema.Struct({
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

/** Native tool authorization is automatic; connection and information prompts are questions. */
export function isCodexMcpPermissionRequest(
  payload: CodexSchema.McpServerElicitationRequestParams,
): boolean {
  return (
    payload.mode !== "url" &&
    typeof payload._meta === "object" &&
    payload._meta !== null &&
    Reflect.get(payload._meta, "codex_approval_kind") === "mcp_tool_call"
  );
}

export function codexMcpElicitationQuestions(
  payload: CodexSchema.McpServerElicitationRequestParams,
): ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion> {
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
