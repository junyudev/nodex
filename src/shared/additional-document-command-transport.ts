import type { BlockPropertyJsonValue } from "./block-property-mutations";
import {
  AdditionalDocumentCommandContractError,
  additionalDocumentCommandCapability,
  parseAdditionalDocumentCommandRequest,
  parseAdditionalDocumentCommandResult,
  type AdditionalDocumentCommandError,
  type AdditionalDocumentOperation,
  type AdditionalDocumentCommandRequest,
  type AdditionalDocumentCommandResult,
} from "./additional-document-commands";

const MAX_ID_LENGTH = 512;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readCanonicalIdentity = (value: unknown, label: string): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value === value.trim()
  ) {
    return value;
  }
  throw new TypeError(`${label} must be a canonical non-empty identity`);
};

const readOperationIdHint = (value: unknown): string => {
  if (!isRecord(value)) return "invalid";
  try {
    return readCanonicalIdentity(value.operationId, "additionalDocument.operationId");
  } catch {
    return "invalid";
  }
};

const readOperationKindHint = (value: unknown): AdditionalDocumentCommandError["operationKind"] => {
  if (!isRecord(value) || !isRecord(value.operation)) return null;
  const kind = value.operation.kind;
  if (typeof kind !== "string") return null;
  try {
    const request = parseAdditionalDocumentCommandRequest({
      operationId: readOperationIdHint(value),
      projectId: "hint",
      storeEpoch: "hint",
      clientSessionId: "hint",
      actor: {},
      coordination: value.coordination,
      operation: value.operation,
    });
    return request.operation.kind;
  } catch {
    return null;
  }
};

export const additionalDocumentCommandFailure = (
  code: AdditionalDocumentCommandError["code"],
  message: string,
  options: {
    readonly operationId?: string;
    readonly operationKind?: AdditionalDocumentCommandError["operationKind"];
    readonly retryable?: boolean;
  } = {},
): AdditionalDocumentCommandError => ({
  code,
  message,
  retryable: options.retryable ?? false,
  operationId: options.operationId ?? "invalid",
  operationKind: options.operationKind ?? null,
});

export interface TrustedAdditionalDocumentCommandIdentity {
  readonly clientSessionId: string;
  readonly actor: Readonly<Record<string, BlockPropertyJsonValue>>;
}

export type PublicAdditionalDocumentOperation = Extract<
  AdditionalDocumentOperation,
  {
    readonly kind:
      | "create_synced_source"
      | "promote_synced_source"
      | "demote_synced_source"
      | "create_template"
      | "instantiate_template";
  }
>;

export type PublicAdditionalDocumentCommandRequest = Omit<
  AdditionalDocumentCommandRequest,
  "operation"
> & {
  readonly operation: PublicAdditionalDocumentOperation;
};

export type BoundAdditionalDocumentCommand =
  | {
      readonly ok: true;
      readonly value: PublicAdditionalDocumentCommandRequest;
    }
  | { readonly ok: false; readonly error: AdditionalDocumentCommandError };

/**
 * Project scope and audit attribution are host evidence. A renderer/browser may
 * carry them for one portable command shape, but neither value survives this
 * boundary. The logical operation and renewable coordination heads do.
 */
export const bindAdditionalDocumentCommandToProject = (
  rawRequest: unknown,
  rawProjectId: unknown,
  identity: TrustedAdditionalDocumentCommandIdentity,
): BoundAdditionalDocumentCommand => {
  let projectId: string;
  try {
    projectId = readCanonicalIdentity(rawProjectId, "projectId");
  } catch (error) {
    return {
      ok: false,
      error: additionalDocumentCommandFailure(
        "invalid_request",
        error instanceof Error ? error.message : "Project scope is invalid",
        {
          operationId: readOperationIdHint(rawRequest),
          operationKind: readOperationKindHint(rawRequest),
        },
      ),
    };
  }

  let request: AdditionalDocumentCommandRequest;
  try {
    request = parseAdditionalDocumentCommandRequest(rawRequest);
  } catch (error) {
    return {
      ok: false,
      error: additionalDocumentCommandFailure(
        "invalid_request",
        error instanceof AdditionalDocumentCommandContractError
          ? error.message
          : "Additional Document command is invalid",
        {
          operationId: readOperationIdHint(rawRequest),
          operationKind: readOperationKindHint(rawRequest),
        },
      ),
    };
  }

  if (request.projectId !== projectId) {
    return {
      ok: false,
      error: additionalDocumentCommandFailure(
        "invalid_request",
        "Additional Document command does not match its Project route scope",
        {
          operationId: request.operationId,
          operationKind: request.operation.kind,
        },
      ),
    };
  }

  const capability = additionalDocumentCommandCapability(request.operation.kind);
  if (capability.availability !== "kernel_ready") {
    return {
      ok: false,
      error: additionalDocumentCommandFailure(
        "capability_gap",
        capability.gap ?? "Additional Document command is not available",
        {
          operationId: request.operationId,
          operationKind: request.operation.kind,
        },
      ),
    };
  }

  try {
    const value = parseAdditionalDocumentCommandRequest({
      ...request,
      projectId,
      clientSessionId: identity.clientSessionId,
      actor: identity.actor,
    });
    return {
      ok: true,
      value: value as PublicAdditionalDocumentCommandRequest,
    };
  } catch (error) {
    return {
      ok: false,
      error: additionalDocumentCommandFailure(
        "invalid_request",
        error instanceof AdditionalDocumentCommandContractError
          ? error.message
          : "Trusted Additional Document command identity is invalid",
        {
          operationId: request.operationId,
          operationKind: request.operation.kind,
        },
      ),
    };
  }
};

export const additionalDocumentCommandTransportFailure = (
  request: AdditionalDocumentCommandRequest,
  error: unknown,
): AdditionalDocumentCommandResult =>
  parseAdditionalDocumentCommandResult({
    ok: false,
    error: additionalDocumentCommandFailure(
      "unknown",
      error instanceof Error
        ? error.message
        : "The durable Additional Document command writer is unavailable",
      {
        operationId: request.operationId,
        operationKind: request.operation.kind,
        retryable: true,
      },
    ),
  });
