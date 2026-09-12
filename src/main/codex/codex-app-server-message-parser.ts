import jsonRpcMessageJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/JSONRPCMessage.schema.json";
import serverNotificationJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ServerNotification.schema.json";
import serverRequestJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ServerRequest.schema.json";
import type {
  RequestId,
  ServerNotification,
  ServerRequest,
} from "@nodex/codex-app-server-protocol";
import { z } from "zod";
import type {
  CodexCanonicalOptionPickerRequest,
  CodexCanonicalPlanImplementationRequest,
  CodexCanonicalSetupContextPickerRequest,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  createGeneratedCodexSchema,
  generatedCodexStringDiscriminatorValues,
} from "../../shared/generated-codex-schema";

export interface CodexInboxItemsCreateServerRequest {
  readonly id: RequestId;
  readonly method: "inbox-items-create";
  readonly params: unknown;
}

export interface CodexMcpUserVerificationServerRequest {
  readonly id: RequestId;
  readonly method: "mcpServer/elicitation/request";
  readonly params: {
    readonly threadId: string;
    readonly mode: "openai/userVerification";
    readonly [key: string]: unknown;
  };
}

export type CodexPrivateServerRequest =
  | CodexMcpUserVerificationServerRequest
  | CodexCanonicalOptionPickerRequest
  | CodexCanonicalPlanImplementationRequest
  | CodexCanonicalSetupContextPickerRequest
  | CodexInboxItemsCreateServerRequest;

export type CodexServerRequest = ServerRequest | CodexPrivateServerRequest;

export interface JsonRpcRequestEnvelope {
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
  readonly trace?: unknown;
}

export interface JsonRpcNotificationEnvelope {
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcResponseEnvelope =
  | {
      readonly id: RequestId;
      readonly result: unknown;
    }
  | {
      readonly id: RequestId;
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    };

type JsonRpcMessage =
  | JsonRpcRequestEnvelope
  | JsonRpcNotificationEnvelope
  | JsonRpcResponseEnvelope;

export type ParsedCodexAppServerMessage =
  | { readonly kind: "notification"; readonly notification: ServerNotification }
  | { readonly kind: "request"; readonly request: CodexServerRequest }
  | { readonly kind: "unknownRequest"; readonly request: JsonRpcRequestEnvelope }
  | { readonly kind: "response"; readonly response: JsonRpcResponseEnvelope };

export type CodexAppServerMessageParseResult =
  | { readonly success: true; readonly data: ParsedCodexAppServerMessage }
  | { readonly success: false; readonly error: string };

const JsonRpcMessageSchema = createGeneratedCodexSchema<JsonRpcMessage>(jsonRpcMessageJsonSchema);
const ServerNotificationSchema = createGeneratedCodexSchema<ServerNotification>(
  serverNotificationJsonSchema,
);
const ServerRequestSchema = createGeneratedCodexSchema<ServerRequest>(serverRequestJsonSchema);

const RequestIdSchema = z.union([z.string(), z.number()]);
const PrivateServerRequestSchema = z.discriminatedUnion("method", [
  z.object({
    id: RequestIdSchema,
    method: z.literal("mcpServer/elicitation/request"),
    params: z
      .object({
        threadId: z.string(),
        mode: z.literal("openai/userVerification"),
      })
      .loose(),
  }),
  z.object({
    id: RequestIdSchema,
    method: z.literal("item/tool/requestOptionPicker"),
    params: z.object({
      threadId: z.string(),
      turnId: z.string(),
      question: z.string(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string().nullable().optional(),
        }),
      ),
      allowMultiple: z.boolean().optional(),
      submitLabel: z.string().nullable().optional(),
      skipLabel: z.string().nullable().optional(),
    }),
  }),
  z.object({
    id: RequestIdSchema,
    method: z.literal("item/tool/requestSetupCodexContextPicker"),
    params: z.object({
      threadId: z.string(),
      turnId: z.string(),
    }),
  }),
  z.object({
    id: RequestIdSchema,
    method: z.literal("item/plan/requestImplementation"),
    params: z.object({
      threadId: z.string(),
      turnId: z.string(),
      planContent: z.string(),
    }),
  }),
  z
    .object({
      id: RequestIdSchema,
      method: z.literal("inbox-items-create"),
      params: z.unknown(),
    })
    .refine((request) => Object.hasOwn(request, "params"), {
      message: "inbox-items-create requires params",
    }),
]) satisfies z.ZodType<CodexPrivateServerRequest>;

const privateServerRequestMethods = new Set<CodexPrivateServerRequest["method"]>([
  "mcpServer/elicitation/request",
  "item/tool/requestOptionPicker",
  "item/tool/requestSetupCodexContextPicker",
  "item/plan/requestImplementation",
  "inbox-items-create",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function generatedStringDiscriminatorValues(
  artifact: unknown,
  discriminator: string,
): ReadonlySet<string> {
  return generatedCodexStringDiscriminatorValues(artifact, discriminator);
}

const generatedServerRequestMethods = generatedStringDiscriminatorValues(
  serverRequestJsonSchema,
  "method",
);
const generatedServerNotificationMethods = generatedStringDiscriminatorValues(
  serverNotificationJsonSchema,
  "method",
);

function invalid(error: string): CodexAppServerMessageParseResult {
  return { success: false, error };
}

export function parseCodexAppServerMessage(value: unknown): CodexAppServerMessageParseResult {
  const envelope = JsonRpcMessageSchema.safeParse(value);
  if (!envelope.success || !isRecord(value)) {
    return invalid("Invalid JSON-RPC envelope from codex app-server.");
  }

  const method = value.method;
  const hasId = Object.hasOwn(value, "id");
  if (typeof method === "string") {
    if (!hasId) {
      const notification = ServerNotificationSchema.safeParse(value);
      if (notification.success) {
        return { success: true, data: { kind: "notification", notification: notification.data } };
      }
      if (generatedServerNotificationMethods.has(method)) {
        return invalid(`Invalid params for Codex server notification '${method}'.`);
      }
      return invalid(`Unknown Codex server notification '${method}'.`);
    }

    const request = ServerRequestSchema.safeParse(value);
    if (request.success) {
      return { success: true, data: { kind: "request", request: request.data } };
    }

    const privateRequest = PrivateServerRequestSchema.safeParse(value);
    if (privateRequest.success) {
      return { success: true, data: { kind: "request", request: privateRequest.data } };
    }

    if (
      generatedServerRequestMethods.has(method) ||
      privateServerRequestMethods.has(method as CodexPrivateServerRequest["method"])
    ) {
      return invalid(`Invalid params for Codex server request '${method}'.`);
    }

    return {
      success: true,
      data: { kind: "unknownRequest", request: envelope.data as JsonRpcRequestEnvelope },
    };
  }

  if (!hasId) {
    return invalid("Unrecognized app-server JSON-RPC message.");
  }

  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    return invalid("Codex JSON-RPC response must contain exactly one of result or error.");
  }

  return {
    success: true,
    data: { kind: "response", response: envelope.data as JsonRpcResponseEnvelope },
  };
}
