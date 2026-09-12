import type { CodexConversationRequestContext } from "./codex-conversation-request-context";
import type { ServerRequest } from "@nodex/codex-app-server-protocol";

import type {
  CodexCanonicalInteractivePendingRequest,
  CodexCanonicalServerRequest,
  CodexOptionPickerOption,
  CodexOptionPickerRequest,
  CodexSetupCodexStepRequest,
  CodexUserInputQuestion,
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

interface OnboardingInputArguments {
  questions: CodexUserInputQuestion[];
}

export interface CodexCanonicalPendingRequestBucket {
  latestUserInputRequest: CodexUserInputRequest | null;
  latestOnboardingInputRequest: CodexUserInputRequest | null;
  latestOptionPickerRequest: CodexOptionPickerRequest | null;
  latestSetupCodexStepRequest: CodexSetupCodexStepRequest | null;
}

const EMPTY_CANONICAL_PENDING_REQUEST_BUCKETS = new Map<
  string,
  CodexCanonicalPendingRequestBucket
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
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

function parseOnboardingQuestion(value: unknown): CodexUserInputQuestion | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "header", "question", "options"])) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.question !== "string" ||
    !Array.isArray(value.options)
  ) {
    return null;
  }
  if (value.header !== undefined && value.header !== null && typeof value.header !== "string")
    return null;
  if (value.options.length < 2) return null;
  const options = value.options.map(parseOption);
  if (options.some((option) => option === null)) return null;
  return {
    id: value.id,
    header: value.header ?? value.question,
    question: value.question,
    isOther: true,
    options: options.map((option) => ({
      label: option?.label ?? "",
      description: option?.description ?? "",
    })),
  };
}

function parseOnboardingInputArguments(value: unknown): OnboardingInputArguments | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["questions"]) || !Array.isArray(value.questions)) {
    return null;
  }
  if (value.questions.length < 1 || value.questions.length > 3) return null;
  const questions = value.questions.map(parseOnboardingQuestion);
  if (questions.some((question) => question === null)) return null;
  return {
    questions: questions.filter(
      (question): question is CodexUserInputQuestion => question !== null,
    ),
  };
}

function parseSetupStep(value: unknown): CodexSetupCodexStepRequest["step"] | "complete" | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["step"])) return null;
  if (
    value.step !== "role" &&
    value.step !== "task" &&
    value.step !== "context" &&
    value.step !== "complete"
  )
    return null;
  return value.step;
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
    latestOnboardingInputRequest: null,
    latestOptionPickerRequest: null,
    latestSetupCodexStepRequest: null,
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

function buildSetupStepRequest(input: {
  conversation: CodexConversationRequestContext;
  request: CodexCanonicalServerRequest;
  turnId: string;
  itemId: string;
  step: CodexSetupCodexStepRequest["step"];
  createdAt: number;
}): CodexSetupCodexStepRequest {
  return {
    type: "setupCodexStep",
    requestId: input.request.id,
    projectId: input.conversation.projectId,
    threadId: input.conversation.threadId,
    turnId: input.turnId,
    itemId: input.itemId,
    step: input.step,
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
  if (request.params.tool === "request_onboarding_input") {
    if (bucket.latestOnboardingInputRequest) return;
    const parsed = parseOnboardingInputArguments(request.params.arguments);
    if (!parsed) return;
    bucket.latestOnboardingInputRequest = {
      type: "userInput",
      requestId: request.id,
      projectId: input.conversation.projectId,
      threadId: input.conversation.threadId,
      turnId: request.params.turnId,
      itemId: request.params.callId,
      isBlocking: true,
      questions: parsed.questions,
      isOnboardingDynamicInput: true,
      createdAt: input.createdAt,
    };
    return;
  }
  if (request.params.tool === "request_option_picker") {
    if (bucket.latestOptionPickerRequest) return;
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
    return;
  }
  if (request.params.tool !== "setup_codex_step" || bucket.latestSetupCodexStepRequest) return;
  const step = parseSetupStep(request.params.arguments);
  if (!step || step === "complete") return;
  bucket.latestSetupCodexStepRequest = buildSetupStepRequest({
    conversation: input.conversation,
    request,
    turnId: request.params.turnId,
    itemId: request.params.callId,
    step,
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
    if (request.method === "item/tool/requestSetupCodexContextPicker") {
      const bucket = getOrCreateBucket(buckets, request.params.turnId);
      if (bucket.latestSetupCodexStepRequest) continue;
      bucket.latestSetupCodexStepRequest = buildSetupStepRequest({
        conversation,
        request,
        turnId: request.params.turnId,
        itemId: `setup-context:${String(request.id)}`,
        step: "context",
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
  return (
    bucket.latestUserInputRequest ??
    bucket.latestOnboardingInputRequest ??
    bucket.latestOptionPickerRequest ??
    bucket.latestSetupCodexStepRequest
  );
}

/** Classifies validated native dynamic requests without a presentation snapshot. */
export function classifyCanonicalDynamicInteractiveRequest(
  request: DynamicToolCallRequest,
): "userInput" | "optionPicker" | "setupCodexStep" | null {
  if (request.params.tool === "request_onboarding_input")
    return parseOnboardingInputArguments(request.params.arguments) ? "userInput" : null;
  if (request.params.tool === "request_option_picker")
    return parseOptionPickerArguments(request.params.arguments) ? "optionPicker" : null;
  if (request.params.tool !== "setup_codex_step") return null;
  const step = parseSetupStep(request.params.arguments);
  return step && step !== "complete" ? "setupCodexStep" : null;
}
