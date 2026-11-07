import type { CodexConversationRequestContext } from "./codex-conversation-request-context";
import type { ServerRequest } from "@nodex/codex-app-server-protocol";

import type {
  CodexCanonicalInteractivePendingRequest,
  CodexCanonicalServerRequest,
  CodexOptionPickerOption,
  CodexOptionPickerRequest,
  CodexUserInputRequest,
} from "./types";

type DynamicToolCallRequest = Extract<ServerRequest, { method: "item/tool/call" }>;

interface OptionPickerArguments {
  question: string;
  options: CodexOptionPickerOption[];
  allowMultiple: boolean;
  submitLabel: string | null;
  skipLabel: string | null;
}

export interface CodexCanonicalPendingRequestBucket {
  latestUserInputRequest: CodexUserInputRequest | null;
  latestOptionPickerRequest: CodexOptionPickerRequest | null;
}

const EMPTY_CANONICAL_PENDING_REQUEST_BUCKETS = new Map<
  string,
  CodexCanonicalPendingRequestBucket
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): CodexOptionPickerOption | null {
  if (!isRecord(value) || typeof value.label !== "string") return null;
  const description = value.description;
  if (description !== undefined && description !== null && typeof description !== "string") {
    return null;
  }
  return {
    label: value.label,
    description: description ?? null,
  };
}

function parseOptionPickerArguments(value: unknown): OptionPickerArguments | null {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.options)) {
    return null;
  }
  const options = value.options.map(parseOption);
  if (options.some((option) => option === null)) return null;
  if (value.allowMultiple !== undefined && typeof value.allowMultiple !== "boolean") return null;
  if (
    value.submitLabel !== undefined &&
    value.submitLabel !== null &&
    typeof value.submitLabel !== "string"
  ) {
    return null;
  }
  if (
    value.skipLabel !== undefined &&
    value.skipLabel !== null &&
    typeof value.skipLabel !== "string"
  ) {
    return null;
  }
  return {
    question: value.question,
    options: options.filter((option): option is CodexOptionPickerOption => option !== null),
    allowMultiple: value.allowMultiple ?? false,
    submitLabel: value.submitLabel ?? null,
    skipLabel: value.skipLabel ?? null,
  };
}

function isDynamicToolCallRequest(
  request: CodexCanonicalServerRequest,
): request is DynamicToolCallRequest {
  return request.method === "item/tool/call";
}

function getOrCreateBucket(
  buckets: Map<string, CodexCanonicalPendingRequestBucket>,
  turnId: string,
): CodexCanonicalPendingRequestBucket {
  const existing = buckets.get(turnId);
  if (existing) return existing;
  const bucket: CodexCanonicalPendingRequestBucket = {
    latestUserInputRequest: null,
    latestOptionPickerRequest: null,
  };
  buckets.set(turnId, bucket);
  return bucket;
}

function buildOptionPickerRequest(input: {
  conversation: CodexConversationRequestContext;
  request: CodexCanonicalServerRequest;
  turnId: string;
  itemId: string;
  arguments: OptionPickerArguments;
  createdAt: number;
}): CodexOptionPickerRequest {
  return {
    type: "optionPicker",
    requestId: input.request.id,
    projectId: input.conversation.projectId,
    threadId: input.conversation.threadId,
    turnId: input.turnId,
    itemId: input.itemId,
    ...input.arguments,
    createdAt: input.createdAt,
  };
}

function projectDirectUserInput(
  conversation: CodexConversationRequestContext,
  request: Extract<CodexCanonicalServerRequest, { method: "item/tool/requestUserInput" }>,
  createdAt: number,
): CodexUserInputRequest {
  return {
    type: "userInput",
    requestId: request.id,
    projectId: conversation.projectId,
    threadId: conversation.threadId,
    turnId: request.params.turnId,
    itemId: request.params.itemId,
    questions: request.params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther === true,
      isSecret: question.isSecret,
      options: question.options?.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
    isBlocking: request.params.isBlocking,
    autoResolutionMs: request.params.autoResolutionMs,
    createdAt,
  };
}

function projectDynamicRequest(input: {
  buckets: Map<string, CodexCanonicalPendingRequestBucket>;
  conversation: CodexConversationRequestContext;
  request: DynamicToolCallRequest;
  createdAt: number;
}): void {
  const { request } = input;
  const bucket = getOrCreateBucket(input.buckets, request.params.turnId);
  if (request.params.tool !== "request_option_picker" || bucket.latestOptionPickerRequest) return;
  const parsed = parseOptionPickerArguments(request.params.arguments);
  if (!parsed) return;
  bucket.latestOptionPickerRequest = buildOptionPickerRequest({
    conversation: input.conversation,
    request,
    turnId: request.params.turnId,
    itemId: request.params.callId,
    arguments: parsed,
    createdAt: input.createdAt,
  });
}

export function buildCodexCanonicalPendingRequestBuckets(
  conversation: CodexConversationRequestContext | null,
): Map<string, CodexCanonicalPendingRequestBucket> {
  const requests = conversation?.canonicalRequests;
  if (!conversation || !requests || requests.length === 0) {
    return EMPTY_CANONICAL_PENDING_REQUEST_BUCKETS;
  }
  const buckets = new Map<string, CodexCanonicalPendingRequestBucket>();
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (!request) continue;
    if (request.method === "item/tool/requestUserInput") {
      const bucket = getOrCreateBucket(buckets, request.params.turnId);
      bucket.latestUserInputRequest ??= projectDirectUserInput(conversation, request, index);
      continue;
    }
    if (request.method === "item/tool/requestOptionPicker") {
      const bucket = getOrCreateBucket(buckets, request.params.turnId);
      if (bucket.latestOptionPickerRequest) continue;
      bucket.latestOptionPickerRequest = buildOptionPickerRequest({
        conversation,
        request,
        turnId: request.params.turnId,
        itemId: `option-picker:${String(request.id)}`,
        arguments: {
          question: request.params.question,
          options: request.params.options.map((option) => ({
            label: option.label,
            description: option.description ?? null,
          })),
          allowMultiple: request.params.allowMultiple ?? false,
          submitLabel: request.params.submitLabel ?? null,
          skipLabel: request.params.skipLabel ?? null,
        },
        createdAt: index,
      });
      continue;
    }
    if (!isDynamicToolCallRequest(request)) continue;
    projectDynamicRequest({ buckets, conversation, request, createdAt: index });
  }
  return buckets;
}

export function selectCanonicalInteractiveRequestForTurn(
  bucket: CodexCanonicalPendingRequestBucket | null | undefined,
): CodexCanonicalInteractivePendingRequest | null {
  if (!bucket) return null;
  return bucket.latestUserInputRequest ?? bucket.latestOptionPickerRequest;
}

/** Classifies validated native dynamic requests without a presentation snapshot. */
export function classifyCanonicalDynamicInteractiveRequest(
  request: DynamicToolCallRequest,
): "optionPicker" | null {
  if (request.params.tool !== "request_option_picker") return null;
  return parseOptionPickerArguments(request.params.arguments) ? "optionPicker" : null;
}
