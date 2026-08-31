import type { McpServerElicitationRequestParams } from "@nodex/codex-app-server-protocol/v2/McpServerElicitationRequestParams";
import type { McpServerElicitationRequestResponse } from "@nodex/codex-app-server-protocol/v2/McpServerElicitationRequestResponse";
import type { CodexMcpServerElicitationAction, CodexMcpServerElicitationRequest } from "./types";

type CodexMcpElicitationJsonValue = McpServerElicitationRequestResponse["content"];
type CodexMcpServerElicitationMode = CodexMcpServerElicitationRequest["mode"];

/** Canonicalizes the legacy wire spelling before the request enters Nodex-owned state. */
export function normalizeCodexMcpServerElicitationMode(
  mode: McpServerElicitationRequestParams["mode"],
): CodexMcpServerElicitationMode {
  return mode === "openaiForm" ? "openai/form" : mode;
}

export type CodexMcpElicitationFieldValue = string | number | boolean | string[];

export type CodexMcpElicitationFormField =
  | {
      kind: "text";
      name: string;
      label: string;
      description: string | null;
      required: boolean;
      defaultValue: string;
      inputType: "text" | "date" | "email" | "url";
      minLength?: number;
      maxLength?: number;
    }
  | {
      kind: "number";
      name: string;
      label: string;
      description: string | null;
      required: boolean;
      defaultValue: string;
      integer: boolean;
      minimum?: number;
      maximum?: number;
    }
  | {
      kind: "boolean";
      name: string;
      label: string;
      description: string | null;
      required: boolean;
      defaultValue: boolean;
    }
  | {
      kind: "singleSelect";
      name: string;
      label: string;
      description: string | null;
      required: boolean;
      defaultValue: string;
      options: Array<{ value: string; label: string }>;
    }
  | {
      kind: "multiSelect";
      name: string;
      label: string;
      description: string | null;
      required: boolean;
      defaultValue: string[];
      options: Array<{ value: string; label: string }>;
    };

type CodexMcpTextInputType = Extract<CodexMcpElicitationFormField, { kind: "text" }>["inputType"];

export type CodexMcpElicitationFormModel =
  | {
      kind: "supported";
      mode: "form" | "openai/form";
      serverName: string;
      message: string;
      serverLabel: string;
      fields: CodexMcpElicitationFormField[];
    }
  | {
      kind: "unsupported";
      mode: "form" | "openai/form";
      serverName: string;
      message: string;
      serverLabel: string;
    };

export interface CodexMcpElicitationValidationResult {
  content: Record<string, CodexMcpElicitationJsonValue> | null;
  invalidFieldNames: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string") ? value : null;
}

function asRequiredNames(value: unknown): Set<string> {
  const values = asStringArray(value);
  return new Set(values ?? []);
}

function titleFromName(name: string): string {
  return (
    name
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase()) || name
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveInputType(format: unknown): CodexMcpTextInputType {
  if (format === "date") return "date";
  if (format === "email") return "email";
  if (format === "uri") return "url";
  return "text";
}

function enumOptionsFromSchema(
  schema: Record<string, unknown>,
): Array<{ value: string; label: string }> | null {
  const directValues = asStringArray(schema.enum);
  if (directValues) {
    const enumNames = asStringArray(schema.enumNames) ?? [];
    return directValues.map((value, index) => ({
      value,
      label: enumNames[index] ?? value,
    }));
  }

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (!oneOf) return null;

  const options: Array<{ value: string; label: string }> = [];
  for (const entry of oneOf) {
    const record = asRecord(entry);
    if (!record || typeof record.const !== "string") return null;
    options.push({
      value: record.const,
      label: typeof record.title === "string" ? record.title : record.const,
    });
  }
  return options;
}

function enumOptionsFromArrayItems(items: unknown): Array<{ value: string; label: string }> | null {
  const itemRecord = asRecord(items);
  if (!itemRecord) return null;
  const directValues = asStringArray(itemRecord.enum);
  if (directValues) {
    return directValues.map((value) => ({ value, label: value }));
  }

  const anyOf = Array.isArray(itemRecord.anyOf) ? itemRecord.anyOf : null;
  if (!anyOf) return null;

  const options: Array<{ value: string; label: string }> = [];
  for (const entry of anyOf) {
    const record = asRecord(entry);
    if (!record || typeof record.const !== "string") return null;
    options.push({
      value: record.const,
      label: typeof record.title === "string" ? record.title : record.const,
    });
  }
  return options;
}

function parseFormField(
  name: string,
  schema: unknown,
  requiredNames: Set<string>,
): CodexMcpElicitationFormField | null {
  const record = asRecord(schema);
  if (!record) return null;

  const label = stringOrNull(record.title) ?? titleFromName(name);
  const description = stringOrNull(record.description);
  const required = requiredNames.has(name);

  if (record.type === "string") {
    const options = enumOptionsFromSchema(record);
    if (options) {
      return {
        kind: "singleSelect",
        name,
        label,
        description,
        required,
        defaultValue: typeof record.default === "string" ? record.default : "",
        options,
      };
    }

    return {
      kind: "text",
      name,
      label,
      description,
      required,
      defaultValue: typeof record.default === "string" ? record.default : "",
      inputType: resolveInputType(record.format),
      minLength: numberOrUndefined(record.minLength),
      maxLength: numberOrUndefined(record.maxLength),
    };
  }

  if (record.type === "number" || record.type === "integer") {
    return {
      kind: "number",
      name,
      label,
      description,
      required,
      defaultValue: typeof record.default === "number" ? String(record.default) : "",
      integer: record.type === "integer",
      minimum: numberOrUndefined(record.minimum),
      maximum: numberOrUndefined(record.maximum),
    };
  }

  if (record.type === "boolean") {
    return {
      kind: "boolean",
      name,
      label,
      description,
      required,
      defaultValue: record.default === true,
    };
  }

  if (record.type === "array") {
    const options = enumOptionsFromArrayItems(record.items);
    if (!options) return null;
    const defaultValue = asStringArray(record.default) ?? [];
    return {
      kind: "multiSelect",
      name,
      label,
      description,
      required,
      defaultValue,
      options,
    };
  }

  return null;
}

function buildServerLabel(mode: "form" | "openai/form", serverName: string): string {
  return mode === "openai/form"
    ? `${serverName} requests information`
    : `${serverName} requests input`;
}

function buildFormFields(
  request: CodexMcpServerElicitationRequest,
): CodexMcpElicitationFormField[] | null {
  const schema = asRecord(request.requestedSchema);
  if (!schema || schema.type !== "object") return null;

  const properties = asRecord(schema.properties);
  if (!properties) return null;

  const requiredNames = asRequiredNames(schema.required);
  const fields: CodexMcpElicitationFormField[] = [];
  for (const [name, fieldSchema] of Object.entries(properties)) {
    const field = parseFormField(name, fieldSchema, requiredNames);
    if (!field) return null;
    fields.push(field);
  }

  return fields;
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isChatGptHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "chatgpt.com" ||
    normalized === "chatgpt-staging.com" ||
    normalized.endsWith(".chatgpt.com") ||
    normalized.endsWith(".chatgpt-staging.com")
  );
}

function hasConnectorAuthFailureMeta(value: unknown): boolean {
  const meta = asRecord(value);
  const codexApps = asRecord(meta?._codex_apps);
  const failure = asRecord(codexApps?.connector_auth_failure);
  return (
    failure?.is_auth_failure === true &&
    typeof failure.connector_id === "string" &&
    typeof failure.connector_name === "string" &&
    typeof failure.install_url === "string" &&
    (failure.auth_reason === undefined || typeof failure.auth_reason === "string") &&
    (failure.link_id === undefined || typeof failure.link_id === "string") &&
    (failure.requested_scopes === undefined ||
      (Array.isArray(failure.requested_scopes) &&
        failure.requested_scopes.every(
          (scope) => typeof scope === "string" && scope.trim().length > 0,
        )))
  );
}

export function isRenderableMcpServerElicitationRequest(
  params: McpServerElicitationRequestParams,
): boolean {
  if (params.mode !== "url") return true;

  const url = parseHttpsUrl(params.url);
  if (!url) return false;

  if (params.serverName !== "codex_apps") return true;

  return isChatGptHost(url.hostname) && hasConnectorAuthFailureMeta(params._meta);
}

export function buildCodexMcpServerElicitationResponse(
  action: CodexMcpServerElicitationAction,
  content?: CodexMcpElicitationJsonValue,
  meta: CodexMcpElicitationJsonValue = null,
): McpServerElicitationRequestResponse {
  if (action !== "accept") {
    return {
      action,
      content: null,
      _meta: meta,
    };
  }

  return {
    action,
    content: content === undefined ? {} : content,
    _meta: meta,
  };
}

export function normalizeCodexMcpServerElicitationResponse(
  response: CodexMcpServerElicitationAction | McpServerElicitationRequestResponse,
): McpServerElicitationRequestResponse {
  if (typeof response === "string") {
    return buildCodexMcpServerElicitationResponse(response);
  }
  return response;
}

export function buildCodexMcpElicitationFormModel(
  request: CodexMcpServerElicitationRequest,
): CodexMcpElicitationFormModel | null {
  if (request.mode !== "form" && request.mode !== "openai/form") return null;

  const fields = buildFormFields(request);
  const base = {
    mode: request.mode,
    serverName: request.serverName.trim() || "Server",
    message: request.message,
    serverLabel: buildServerLabel(request.mode, request.serverName.trim() || "Server"),
  };

  if (!fields) {
    return {
      kind: "unsupported",
      ...base,
    };
  }

  return {
    kind: "supported",
    ...base,
    fields,
  };
}

export function createInitialCodexMcpElicitationFormValues(
  fields: CodexMcpElicitationFormField[],
): Record<string, CodexMcpElicitationFieldValue> {
  return Object.fromEntries(
    fields.map((field) => {
      switch (field.kind) {
        case "text":
        case "number":
        case "singleSelect":
          return [field.name, field.defaultValue];
        case "boolean":
          return [field.name, field.defaultValue];
        case "multiSelect":
          return [field.name, [...field.defaultValue]];
      }
    }),
  );
}

function validateTextField(
  field: Extract<CodexMcpElicitationFormField, { kind: "text" }>,
  value: CodexMcpElicitationFieldValue | undefined,
): { valid: boolean; content?: string } {
  const content = typeof value === "string" ? value : "";
  if (field.required && content.trim().length === 0) return { valid: false };
  if (field.minLength !== undefined && content.length < field.minLength) return { valid: false };
  if (field.maxLength !== undefined && content.length > field.maxLength) return { valid: false };
  return { valid: true, content };
}

function validateNumberField(
  field: Extract<CodexMcpElicitationFormField, { kind: "number" }>,
  value: CodexMcpElicitationFieldValue | undefined,
): { valid: boolean; content?: number } {
  if (value === "" || value === undefined) {
    return field.required ? { valid: false } : { valid: true };
  }
  const content = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(content)) return { valid: false };
  if (field.integer && !Number.isInteger(content)) return { valid: false };
  if (field.minimum !== undefined && content < field.minimum) return { valid: false };
  if (field.maximum !== undefined && content > field.maximum) return { valid: false };
  return { valid: true, content };
}

function validateSelectField(
  field: Extract<CodexMcpElicitationFormField, { kind: "singleSelect" }>,
  value: CodexMcpElicitationFieldValue | undefined,
): { valid: boolean; content?: string } {
  const content = typeof value === "string" ? value : "";
  if (field.required && content.trim().length === 0) return { valid: false };
  if (content && !field.options.some((option) => option.value === content)) return { valid: false };
  return { valid: true, content };
}

function validateMultiSelectField(
  field: Extract<CodexMcpElicitationFormField, { kind: "multiSelect" }>,
  value: CodexMcpElicitationFieldValue | undefined,
): { valid: boolean; content?: string[] } {
  const content = Array.isArray(value) ? value : [];
  if (field.required && content.length === 0) return { valid: false };
  if (content.some((selected) => !field.options.some((option) => option.value === selected))) {
    return { valid: false };
  }
  return { valid: true, content };
}

export function validateCodexMcpElicitationFormValues(
  fields: CodexMcpElicitationFormField[],
  values: Record<string, CodexMcpElicitationFieldValue>,
): CodexMcpElicitationValidationResult {
  const content: Record<string, CodexMcpElicitationJsonValue> = {};
  const invalidFieldNames: string[] = [];

  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "text") {
      const result = validateTextField(field, value);
      if (!result.valid) {
        invalidFieldNames.push(field.name);
        continue;
      }
      if (result.content !== undefined) content[field.name] = result.content;
      continue;
    }

    if (field.kind === "number") {
      const result = validateNumberField(field, value);
      if (!result.valid) {
        invalidFieldNames.push(field.name);
        continue;
      }
      if (result.content !== undefined) content[field.name] = result.content;
      continue;
    }

    if (field.kind === "singleSelect") {
      const result = validateSelectField(field, value);
      if (!result.valid) {
        invalidFieldNames.push(field.name);
        continue;
      }
      if (result.content !== undefined) content[field.name] = result.content;
      continue;
    }

    if (field.kind === "multiSelect") {
      const result = validateMultiSelectField(field, value);
      if (!result.valid) {
        invalidFieldNames.push(field.name);
        continue;
      }
      if (result.content !== undefined) content[field.name] = result.content;
      continue;
    }

    content[field.name] = value === true;
  }

  return {
    content: invalidFieldNames.length === 0 ? content : null,
    invalidFieldNames,
  };
}
