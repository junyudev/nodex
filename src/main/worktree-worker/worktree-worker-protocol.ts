import { z } from "zod";
import {
  WorktreeWorkerEventSchema,
  WorktreeWorkerHostIdSchema,
  WorktreeWorkerIdSchema,
  WorktreeWorkerOperationSchema,
  WorktreeWorkerRequestSchema,
  WorktreeWorkerSuccessSchema,
  type CodexWorktreeWorkerRequest,
} from "../codex/codex-worktree-worker-protocol";

export const CODEX_WORKTREE_WORKER_PROTOCOL_VERSION = 10 as const;

const ProtocolVersionSchema = z.literal(CODEX_WORKTREE_WORKER_PROTOCOL_VERSION, {
  error: ({ input }) => {
    const received =
      typeof input === "number" || typeof input === "string" ? String(input) : typeof input;
    return `Worktree worker protocol version mismatch (expected ${CODEX_WORKTREE_WORKER_PROTOCOL_VERSION}, received ${received})`;
  },
});

const RequestMessageSchema = z.strictObject({
  type: z.literal("request"),
  protocolVersion: ProtocolVersionSchema,
  id: WorktreeWorkerIdSchema,
  request: WorktreeWorkerRequestSchema.readonly(),
});
// A bad body can be rejected independently if the worker can still route its reply.
const RequestEnvelopeSchema = RequestMessageSchema.extend({
  request: z.object({ operation: WorktreeWorkerOperationSchema }).readonly(),
});

const HostMessageSchema = z.discriminatedUnion("type", [
  RequestMessageSchema,
  z.strictObject({
    type: z.literal("cancel"),
    protocolVersion: ProtocolVersionSchema,
    id: WorktreeWorkerIdSchema,
    operation: WorktreeWorkerOperationSchema,
  }),
  z.strictObject({
    type: z.literal("shutdown"),
    protocolVersion: ProtocolVersionSchema,
  }),
]);

const replyIdentity = { id: WorktreeWorkerIdSchema, operation: WorktreeWorkerOperationSchema };
const EventMessageSchema = z
  .object({
    type: z.literal("event"),
    ...replyIdentity,
    event: WorktreeWorkerEventSchema.readonly(),
  })
  .refine((message) => message.event.operation === message.operation, {
    path: ["event", "operation"],
    message: "Must match the message operation",
  });

const ResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ok"), success: WorktreeWorkerSuccessSchema.readonly() }),
  z.object({
    type: z.literal("error"),
    code: z.enum(["canceled", "invalid-request", "operation-failed", "release-unconfirmed"]),
    message: z.string(),
    retryable: z.boolean(),
    preparationRestored: z.boolean().optional(),
  }),
]);

const ResultMessageSchema = z
  .object({
    type: z.literal("result"),
    ...replyIdentity,
    result: ResultSchema.readonly(),
  })
  .refine(
    ({ result, operation }) => result.type !== "ok" || result.success.operation === operation,
    { path: ["result", "success", "operation"], message: "Must match the message operation" },
  )
  .refine(
    ({ result, operation }) =>
      result.type !== "error" ||
      result.preparationRestored === undefined ||
      operation === "prepare-handoff",
    {
      path: ["result", "preparationRestored"],
      message: "Only allowed for prepare-handoff errors",
    },
  );

const ThreadMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    epoch: z.int(),
    hostId: WorktreeWorkerHostIdSchema,
    protocolVersion: ProtocolVersionSchema,
  }),
  EventMessageSchema,
  ResultMessageSchema,
]);

export type CodexWorktreeWorkerHostMessage = Readonly<z.output<typeof HostMessageSchema>>;
export type CodexWorktreeWorkerThreadMessage = Readonly<z.output<typeof ThreadMessageSchema>>;

type DecodeFailure = { readonly ok: false; readonly error: string };
type DecodeResult<Value, Failure = DecodeFailure> =
  | { readonly ok: true; readonly value: Value }
  | Failure;
type HostDecodeResult = DecodeResult<
  CodexWorktreeWorkerHostMessage,
  DecodeFailure & { readonly envelope?: Readonly<z.output<typeof RequestEnvelopeSchema>> }
>;

function formatIssue(issue: z.ZodIssue | undefined): string {
  if (!issue) return "message: Invalid input";
  const unrecognizedKey = issue.code === "unrecognized_keys" ? issue.keys[0] : undefined;
  const path = unrecognizedKey === undefined ? issue.path : [...issue.path, unrecognizedKey];
  const location = path.map((key) => String(key).slice(0, 80)).join(".") || "message";
  const problem = unrecognizedKey === undefined ? issue.message : "Unrecognized key";
  return `${location}: ${problem}`.replace(/\s+/gu, " ").slice(0, 512);
}

export function decodeCodexWorktreeWorkerHostMessage(value: unknown): HostDecodeResult {
  const parsed = HostMessageSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const error = formatIssue(parsed.error.issues[0]);
  const envelope = RequestEnvelopeSchema.safeParse(value);
  return envelope.success ? { ok: false, error, envelope: envelope.data } : { ok: false, error };
}

export function decodeCodexWorktreeWorkerThreadMessage(
  value: unknown,
): DecodeResult<CodexWorktreeWorkerThreadMessage> {
  const parsed = ThreadMessageSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: formatIssue(parsed.error.issues[0]) };
}

export function validateOutgoingCodexWorktreeWorkerHostMessage(
  message: CodexWorktreeWorkerHostMessage,
): CodexWorktreeWorkerHostMessage {
  const decoded = decodeCodexWorktreeWorkerHostMessage(message);
  if (decoded.ok) return decoded.value;
  if (message.type === "request") {
    const operation = WorktreeWorkerOperationSchema.safeParse(message.request?.operation);
    const name = operation.success ? ` "${operation.data}"` : "";
    throw new Error(
      `Nodex built an invalid worktree${name} request: ${decoded.error.replace(/^request\./u, "")}`,
    );
  }
  throw new Error(`Nodex built an invalid worktree "${message.type}" message: ${decoded.error}`);
}

export function createCodexWorktreeWorkerRequestMessage(input: {
  readonly id: string;
  readonly request: CodexWorktreeWorkerRequest;
}): CodexWorktreeWorkerHostMessage {
  return validateOutgoingCodexWorktreeWorkerHostMessage({
    type: "request",
    protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
    id: input.id,
    request: input.request,
  });
}
