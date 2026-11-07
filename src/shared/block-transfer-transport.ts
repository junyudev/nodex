import {
  BlockTransferContractError,
  parseBlockTransferIntent,
  parseBlockTransferUndoIntent,
  type BlockTransferCommandError,
  type BlockTransferIntent,
  type BlockTransferUndoIntent,
} from "./block-transfer";
import type { DatabaseJsonValue } from "./database-kernel";

const MAX_ID_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 4_096;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readIdentityHint = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_ID_LENGTH ||
    candidate !== candidate.trim()
  ) {
    return undefined;
  }
  return candidate;
};

export type PublicBlockTransferIntent = Omit<BlockTransferIntent, "clientSessionId" | "actor">;
export type PublicBlockTransferUndoIntent = BlockTransferUndoIntent;

export interface TrustedBlockTransferIdentity {
  readonly clientSessionId: string;
  readonly actor: Readonly<Record<string, DatabaseJsonValue>>;
}

export type BoundBlockTransferIntent =
  | { readonly ok: true; readonly value: BlockTransferIntent }
  | { readonly ok: false; readonly error: BlockTransferCommandError };
export type BoundBlockTransferUndoIntent =
  | { readonly ok: true; readonly value: BlockTransferUndoIntent }
  | { readonly ok: false; readonly error: BlockTransferCommandError };

export const blockTransferFailure = (
  code: BlockTransferCommandError["code"],
  message: string,
  options: {
    readonly operationId?: string;
    readonly retryable?: boolean;
    readonly reloadRequired?: boolean;
  } = {},
): BlockTransferCommandError => ({
  code,
  message:
    message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`,
  retryable: options.retryable ?? false,
  reloadRequired: options.reloadRequired ?? false,
  ...(options.operationId ? { operationId: options.operationId } : {}),
});

const parsePublicIntent = (
  value: unknown,
  identity: TrustedBlockTransferIdentity,
): BlockTransferIntent => {
  if (!isRecord(value)) {
    throw new BlockTransferContractError("blockTransferIntent must be an object");
  }
  const allowed = new Set([
    "version",
    "operationId",
    "projectId",
    "storeEpoch",
    "mode",
    "rootBlockIds",
    "causalDependencies",
    "source",
    "target",
    "promotionPolicy",
  ]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    throw new BlockTransferContractError(`blockTransferIntent.${key} is not supported`);
  }
  return parseBlockTransferIntent({
    ...value,
    clientSessionId: identity.clientSessionId,
    actor: identity.actor,
  });
};

/** Bind the selected presentation route and host-owned audit identity. */
export const bindBlockTransferIntent = (
  rawIntent: unknown,
  rawProjectId: unknown,
  identity: TrustedBlockTransferIdentity,
): BoundBlockTransferIntent => {
  const projectId =
    typeof rawProjectId === "string" &&
    rawProjectId.length > 0 &&
    rawProjectId.length <= MAX_ID_LENGTH &&
    rawProjectId === rawProjectId.trim()
      ? rawProjectId
      : null;
  const operationId = readIdentityHint(rawIntent, "operationId");
  if (rawProjectId !== null && projectId === null) {
    return {
      ok: false,
      error: blockTransferFailure(
        "invalid_transfer_request",
        "Block transfer Project route is invalid",
        { operationId },
      ),
    };
  }
  let intent: BlockTransferIntent;
  try {
    intent = parsePublicIntent(rawIntent, identity);
  } catch (error) {
    return {
      ok: false,
      error: blockTransferFailure(
        "invalid_transfer_request",
        error instanceof BlockTransferContractError
          ? error.message
          : "Block transfer intent is invalid",
        { operationId },
      ),
    };
  }
  if (intent.projectId !== projectId) {
    return {
      ok: false,
      error: blockTransferFailure(
        "invalid_transfer_request",
        "Block transfer intent does not match its presentation route",
        { operationId: intent.operationId },
      ),
    };
  }
  return { ok: true, value: intent };
};

export const bindBlockTransferUndoIntent = (
  rawIntent: unknown,
  rawProjectId: unknown,
): BoundBlockTransferUndoIntent => {
  const projectId =
    typeof rawProjectId === "string" &&
    rawProjectId.length > 0 &&
    rawProjectId.length <= MAX_ID_LENGTH &&
    rawProjectId === rawProjectId.trim()
      ? rawProjectId
      : null;
  const operationId = readIdentityHint(rawIntent, "operationId");
  if (rawProjectId !== null && projectId === null) {
    return {
      ok: false,
      error: blockTransferFailure(
        "invalid_transfer_request",
        "Block transfer Undo Project route is invalid",
        { operationId },
      ),
    };
  }
  try {
    const intent = parseBlockTransferUndoIntent(rawIntent);
    if (intent.projectId !== projectId) {
      return {
        ok: false,
        error: blockTransferFailure(
          "invalid_transfer_request",
          "Block transfer Undo does not match its presentation route",
          { operationId: intent.operationId },
        ),
      };
    }
    return { ok: true, value: intent };
  } catch (error) {
    return {
      ok: false,
      error: blockTransferFailure(
        "invalid_transfer_request",
        error instanceof BlockTransferContractError
          ? error.message
          : "Block transfer Undo intent is invalid",
        { operationId },
      ),
    };
  }
};
