import { sha256 } from "@noble/hashes/sha2.js";

export const DEFAULT_RENDERER_CAUSAL_TRACE_CAPACITY = 256;
export const MAX_RENDERER_CAUSAL_TRACE_CAPACITY = 4_096;

export type RendererCausalTraceProtocol =
  | "receipt_fenced_projection"
  | "local_document_replica"
  | "local_scene_outbox"
  | "revision_fenced_local"
  | "returned_value"
  | "pending_operation";

export type RendererCausalTraceScopeKind =
  | "application"
  | "workspace"
  | "project"
  | "session"
  | "library"
  | "page"
  | "database"
  | "document"
  | "canvas"
  | "window"
  | "thread"
  | "external"
  | "unknown";

export interface RendererCausalTraceContext {
  readonly semanticKey: string;
  readonly operationIdentityHash: string;
  readonly owner: string;
  readonly protocol: RendererCausalTraceProtocol;
  readonly scopeKind: RendererCausalTraceScopeKind;
}

interface RendererCausalTraceReasonByKind {
  readonly local_intent: "local_intent";
  readonly submitted: "transport_submit";
  readonly acknowledged: "committed" | "revision_accepted";
  readonly no_op: "no_op";
  readonly materialized: "canonical_observation";
  readonly rendered: "render_handoff";
  readonly settled: "proof_complete";
  readonly result: "transport_result" | "terminal_result";
  readonly pending: "accepted_pending";
  readonly failed:
    | "delivery_admission_failure"
    | "domain_failure"
    | "invalid_acknowledgement"
    | "transport_failure";
  readonly superseded: "newer_intent";
  readonly revoked: "authority_revoked" | "store_reset";
}

export type RendererCausalTraceEventKind = keyof RendererCausalTraceReasonByKind;

export type RendererCausalTraceEventInput = {
  readonly [Kind in RendererCausalTraceEventKind]: Readonly<{
    readonly kind: Kind;
    readonly reason: RendererCausalTraceReasonByKind[Kind];
  }> &
    (Kind extends "materialized" | "rendered"
      ? { readonly renderToken: number }
      : { readonly renderToken?: never });
}[RendererCausalTraceEventKind];

export interface RendererCausalTraceEvent extends RendererCausalTraceContext {
  readonly sequence: number;
  readonly timestamp: number;
  readonly kind: RendererCausalTraceEventKind;
  readonly reason: RendererCausalTraceReasonByKind[RendererCausalTraceEventKind];
  readonly renderToken: number | null;
}

export interface RendererCausalTraceSnapshot {
  readonly capacity: number;
  readonly droppedEventCount: number;
  readonly events: readonly RendererCausalTraceEvent[];
}

export type RendererCausalTraceViolationCode =
  | "event_after_terminal"
  | "late_local_intent"
  | "missing_acknowledgement"
  | "missing_local_intent"
  | "missing_materialization"
  | "missing_pending_acceptance"
  | "missing_render"
  | "missing_result"
  | "missing_submission"
  | "render_token_mismatch";

export interface RendererCausalTraceViolation {
  readonly code: RendererCausalTraceViolationCode;
  readonly operationIdentityHash: string;
  readonly sequence: number;
}

export type RendererCausalTraceOutcome =
  | "active"
  | "acknowledged"
  | "no_op"
  | "pending"
  | "result"
  | "settled"
  | "failed"
  | "superseded"
  | "revoked";

export interface RendererCausalTraceOperationState extends RendererCausalTraceContext {
  readonly acknowledged: boolean;
  readonly localIntent: boolean;
  readonly materialized: boolean;
  readonly outcome: RendererCausalTraceOutcome;
  readonly pending: boolean;
  readonly rendered: boolean;
  readonly result: boolean;
  readonly submitted: boolean;
}

export interface RendererCausalTraceReduction {
  readonly historyComplete: boolean;
  readonly legal: boolean;
  readonly operations: readonly RendererCausalTraceOperationState[];
  readonly violations: readonly RendererCausalTraceViolation[];
}

export interface RendererCausalTrace {
  readonly enabled: boolean;
  clear(): void;
  record(context: RendererCausalTraceContext, event: RendererCausalTraceEventInput): boolean;
  reduce(): RendererCausalTraceReduction;
  snapshot(): RendererCausalTraceSnapshot;
}

interface MutableOperationState extends RendererCausalTraceContext {
  acknowledged: boolean;
  localIntent: boolean;
  materializedTokens: Set<number>;
  outcome: RendererCausalTraceOutcome;
  pending: boolean;
  renderedTokens: Set<number>;
  result: boolean;
  submitted: boolean;
  terminal: boolean;
  terminalResult: boolean;
}

export interface CreateRendererCausalTraceOptions {
  readonly enabled: boolean;
  readonly capacity?: number;
  readonly now?: () => number;
}

interface RendererCommandTraceDefinition {
  readonly key: string;
  readonly owner: string;
  readonly protocol: { readonly kind: RendererCausalTraceProtocol };
  readonly trace?: { readonly scopeKind: RendererCausalTraceScopeKind };
}

const TRACE_PROTOCOLS = new Set<RendererCausalTraceProtocol>([
  "receipt_fenced_projection",
  "local_document_replica",
  "local_scene_outbox",
  "revision_fenced_local",
  "returned_value",
  "pending_operation",
]);

const TRACE_SCOPE_KINDS = new Set<RendererCausalTraceScopeKind>([
  "application",
  "workspace",
  "project",
  "session",
  "library",
  "page",
  "database",
  "document",
  "canvas",
  "window",
  "thread",
  "external",
  "unknown",
]);

const TRACE_EVENT_REASONS = {
  local_intent: ["local_intent"],
  submitted: ["transport_submit"],
  acknowledged: ["committed", "revision_accepted"],
  no_op: ["no_op"],
  materialized: ["canonical_observation"],
  rendered: ["render_handoff"],
  settled: ["proof_complete"],
  result: ["transport_result", "terminal_result"],
  pending: ["accepted_pending"],
  failed: [
    "delivery_admission_failure",
    "domain_failure",
    "invalid_acknowledgement",
    "transport_failure",
  ],
  superseded: ["newer_intent"],
  revoked: ["authority_revoked", "store_reset"],
} as const satisfies {
  readonly [Kind in RendererCausalTraceEventKind]: readonly RendererCausalTraceReasonByKind[Kind][];
};

const TERMINAL_KINDS = new Set<RendererCausalTraceEventKind>(["revoked", "settled", "superseded"]);

const isTerminalEvent = (event: RendererCausalTraceEvent): boolean =>
  TERMINAL_KINDS.has(event.kind) ||
  (event.kind === "failed" && event.reason !== "transport_failure");

const isExpectedLateTransportEvidence = (
  outcome: RendererCausalTraceOutcome,
  event: RendererCausalTraceEvent,
): boolean =>
  (outcome === "superseded" || outcome === "revoked") &&
  (event.kind === "acknowledged" ||
    event.kind === "no_op" ||
    event.kind === "result" ||
    event.kind === "failed");

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const hashRendererOperationIdentity = (operationIdentity: string): string =>
  bytesToHex(sha256(new TextEncoder().encode(operationIdentity)));

const codeLabel = (value: string, label: string, maximum: number): string => {
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.length === 0 ||
    normalized.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)
  ) {
    throw new TypeError(`${label} must be a bounded code identifier`);
  }
  return normalized;
};

const validContext = (context: RendererCausalTraceContext): RendererCausalTraceContext => {
  if (!/^[a-f0-9]{64}$/u.test(context.operationIdentityHash)) {
    throw new TypeError("operationIdentityHash must be a lowercase SHA-256 digest");
  }
  if (!TRACE_PROTOCOLS.has(context.protocol)) throw new TypeError("protocol is invalid");
  if (!TRACE_SCOPE_KINDS.has(context.scopeKind)) throw new TypeError("scopeKind is invalid");
  return {
    semanticKey: codeLabel(context.semanticKey, "semanticKey", 160),
    operationIdentityHash: context.operationIdentityHash,
    owner: codeLabel(context.owner, "owner", 96),
    protocol: context.protocol,
    scopeKind: context.scopeKind,
  };
};

const validateEventInput = (input: RendererCausalTraceEventInput): void => {
  const reasons = (TRACE_EVENT_REASONS as Readonly<Record<string, readonly string[]>>)[input.kind];
  if (!reasons?.includes(input.reason)) throw new TypeError("trace event kind/reason is invalid");
  const requiresRenderToken = input.kind === "materialized" || input.kind === "rendered";
  if (requiresRenderToken !== (input.renderToken !== undefined)) {
    throw new TypeError("trace event renderToken contract is invalid");
  }
};

const operationIdentityFromArgs = (args: readonly unknown[]): string | null => {
  for (const value of args) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    if (!("operationId" in value) || typeof value.operationId !== "string") continue;
    if (value.operationId.length === 0 || value.operationId.length > 512) continue;
    return value.operationId;
  }
  return null;
};

const inferredScopeKind = (semanticKey: string): RendererCausalTraceScopeKind => {
  const candidates: readonly RendererCausalTraceScopeKind[] = [
    "project",
    "session",
    "library",
    "page",
    "database",
    "document",
    "canvas",
    "window",
    "thread",
    "workspace",
    "application",
    "external",
  ];
  const normalized = `.${semanticKey.toLowerCase().replaceAll(/[^a-z0-9]+/gu, ".")}.`;
  return candidates.find((candidate) => normalized.includes(`.${candidate}.`)) ?? "unknown";
};

export const rendererCausalTraceEnabledForMode = (mode: "development" | "production"): boolean =>
  mode === "development";

export const createRendererCausalTraceContext = (input: {
  readonly semanticKey: string;
  readonly operationIdentity: string;
  readonly owner: string;
  readonly protocol: RendererCausalTraceProtocol;
  readonly scopeKind: RendererCausalTraceScopeKind;
}): RendererCausalTraceContext => {
  if (input.operationIdentity.length === 0 || input.operationIdentity.length > 512) {
    throw new TypeError("operationIdentity must contain 1-512 characters");
  }
  return validContext({
    semanticKey: input.semanticKey,
    operationIdentityHash: hashRendererOperationIdentity(input.operationIdentity),
    owner: input.owner,
    protocol: input.protocol,
    scopeKind: input.scopeKind,
  });
};

export const beginRendererCommandTrace = (
  definition: RendererCommandTraceDefinition,
  args: readonly unknown[],
): RendererCausalTraceContext | null => {
  if (!rendererCausalTrace.enabled) return null;
  const operationIdentity = operationIdentityFromArgs(args);
  if (!operationIdentity) return null;
  try {
    return createRendererCausalTraceContext({
      semanticKey: definition.key,
      operationIdentity,
      owner: definition.owner,
      protocol: definition.protocol.kind,
      scopeKind: definition.trace?.scopeKind ?? inferredScopeKind(definition.key),
    });
  } catch {
    return null;
  }
};

const addViolation = (
  violations: RendererCausalTraceViolation[],
  event: RendererCausalTraceEvent,
  code: RendererCausalTraceViolationCode,
): void => {
  violations.push({
    code,
    operationIdentityHash: event.operationIdentityHash,
    sequence: event.sequence,
  });
};

const missingProof = (
  historyComplete: boolean,
  condition: boolean,
  violations: RendererCausalTraceViolation[],
  event: RendererCausalTraceEvent,
  code: RendererCausalTraceViolationCode,
): void => {
  if (condition || !historyComplete) return;
  addViolation(violations, event, code);
};

const settlementRequirements = (
  state: MutableOperationState,
  event: RendererCausalTraceEvent,
  historyComplete: boolean,
  violations: RendererCausalTraceViolation[],
): void => {
  const projectionProtocol =
    state.protocol === "receipt_fenced_projection" ||
    state.protocol === "local_document_replica" ||
    state.protocol === "local_scene_outbox" ||
    state.protocol === "revision_fenced_local";
  if (projectionProtocol) {
    missingProof(historyComplete, state.acknowledged, violations, event, "missing_acknowledgement");
    missingProof(
      historyComplete,
      state.materializedTokens.size > 0,
      violations,
      event,
      "missing_materialization",
    );
    missingProof(
      historyComplete,
      [...state.renderedTokens].some((token) => state.materializedTokens.has(token)),
      violations,
      event,
      "missing_render",
    );
    return;
  }
  if (state.protocol === "returned_value") {
    missingProof(historyComplete, state.result, violations, event, "missing_result");
    return;
  }
  missingProof(historyComplete, state.pending, violations, event, "missing_pending_acceptance");
  missingProof(historyComplete, state.terminalResult, violations, event, "missing_result");
};

export const reduceRendererCausalTrace = (
  snapshot: RendererCausalTraceSnapshot,
): RendererCausalTraceReduction => {
  const historyComplete = snapshot.droppedEventCount === 0;
  const operations = new Map<string, MutableOperationState>();
  const violations: RendererCausalTraceViolation[] = [];

  for (const event of snapshot.events) {
    const state = operations.get(event.operationIdentityHash) ?? {
      semanticKey: event.semanticKey,
      operationIdentityHash: event.operationIdentityHash,
      owner: event.owner,
      protocol: event.protocol,
      scopeKind: event.scopeKind,
      acknowledged: false,
      localIntent: false,
      materializedTokens: new Set<number>(),
      outcome: "active" as const,
      pending: false,
      renderedTokens: new Set<number>(),
      result: false,
      submitted: false,
      terminal: false,
      terminalResult: false,
    };
    operations.set(event.operationIdentityHash, state);

    if (state.terminal && isExpectedLateTransportEvidence(state.outcome, event)) continue;
    if (state.terminal) {
      addViolation(violations, event, "event_after_terminal");
      continue;
    }

    if (event.kind === "local_intent") {
      if (state.submitted) addViolation(violations, event, "late_local_intent");
      state.localIntent = true;
    }
    if (event.kind === "submitted") {
      missingProof(historyComplete, state.localIntent, violations, event, "missing_local_intent");
      state.submitted = true;
    }
    if (event.kind === "acknowledged" || event.kind === "no_op") {
      missingProof(historyComplete, state.submitted, violations, event, "missing_submission");
      state.acknowledged = true;
      state.outcome = event.kind === "no_op" ? "no_op" : "acknowledged";
    }
    if (event.kind === "materialized") {
      missingProof(historyComplete, state.submitted, violations, event, "missing_submission");
      if (event.renderToken === null) addViolation(violations, event, "render_token_mismatch");
      else state.materializedTokens.add(event.renderToken);
    }
    if (event.kind === "rendered") {
      if (event.renderToken === null || !state.materializedTokens.has(event.renderToken)) {
        addViolation(violations, event, "render_token_mismatch");
      } else {
        state.renderedTokens.add(event.renderToken);
      }
    }
    if (event.kind === "pending") {
      missingProof(historyComplete, state.submitted, violations, event, "missing_submission");
      state.pending = true;
      state.outcome = "pending";
    }
    if (event.kind === "result") {
      missingProof(historyComplete, state.submitted, violations, event, "missing_submission");
      state.result = true;
      if (event.reason === "terminal_result") state.terminalResult = true;
      state.outcome = "result";
    }
    if (event.kind === "settled") {
      settlementRequirements(state, event, historyComplete, violations);
      state.outcome = "settled";
    }
    if (event.kind === "failed") state.outcome = "failed";
    if (event.kind === "superseded") state.outcome = "superseded";
    if (event.kind === "revoked") state.outcome = "revoked";
    if (isTerminalEvent(event)) state.terminal = true;
  }

  return {
    historyComplete,
    legal: violations.length === 0,
    operations: [...operations.values()].map((state) => ({
      semanticKey: state.semanticKey,
      operationIdentityHash: state.operationIdentityHash,
      owner: state.owner,
      protocol: state.protocol,
      scopeKind: state.scopeKind,
      acknowledged: state.acknowledged,
      localIntent: state.localIntent,
      materialized: state.materializedTokens.size > 0,
      outcome: state.outcome,
      pending: state.pending,
      rendered: state.renderedTokens.size > 0,
      result: state.result,
      submitted: state.submitted,
    })),
    violations,
  };
};

export const createRendererCausalTrace = (
  options: CreateRendererCausalTraceOptions,
): RendererCausalTrace => {
  const capacity = options.capacity ?? DEFAULT_RENDERER_CAUSAL_TRACE_CAPACITY;
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_RENDERER_CAUSAL_TRACE_CAPACITY
  ) {
    throw new RangeError(
      `capacity must be an integer between 1 and ${MAX_RENDERER_CAUSAL_TRACE_CAPACITY}`,
    );
  }
  if (!options.enabled) {
    const emptySnapshot = (): RendererCausalTraceSnapshot => ({
      capacity,
      droppedEventCount: 0,
      events: [],
    });
    return {
      enabled: false,
      clear: () => undefined,
      record: () => false,
      reduce: () => reduceRendererCausalTrace(emptySnapshot()),
      snapshot: emptySnapshot,
    };
  }

  const slots = new Array<RendererCausalTraceEvent | undefined>(capacity);
  const now = options.now ?? Date.now;
  let droppedEventCount = 0;
  let nextIndex = 0;
  let sequence = 0;
  let size = 0;

  const snapshot = (): RendererCausalTraceSnapshot => {
    const start = size === capacity ? nextIndex : 0;
    const events = Array.from({ length: size }, (_, offset) => {
      const event = slots[(start + offset) % capacity];
      if (!event) throw new Error("Renderer causal trace ring is internally inconsistent");
      return { ...event };
    });
    return { capacity, droppedEventCount, events };
  };

  return {
    enabled: true,
    clear: () => {
      slots.fill(undefined);
      droppedEventCount = 0;
      nextIndex = 0;
      sequence = 0;
      size = 0;
    },
    record: (unsafeContext, input) => {
      const context = validContext(unsafeContext);
      validateEventInput(input);
      const renderToken = input.renderToken ?? null;
      if (renderToken !== null && (!Number.isSafeInteger(renderToken) || renderToken < 0)) {
        throw new TypeError("renderToken must be a non-negative safe integer");
      }
      sequence += 1;
      slots[nextIndex] = {
        ...context,
        sequence,
        timestamp: now(),
        kind: input.kind,
        reason: input.reason,
        renderToken,
      };
      nextIndex = (nextIndex + 1) % capacity;
      if (size < capacity) size += 1;
      else droppedEventCount += 1;
      return true;
    },
    reduce: () => reduceRendererCausalTrace(snapshot()),
    snapshot,
  };
};

const mode = import.meta.env.DEV ? "development" : "production";

/** Bounded, allowlisted development diagnostics. It is never a semantic authority. */
export const rendererCausalTrace = createRendererCausalTrace({
  enabled: rendererCausalTraceEnabledForMode(mode),
});

export const recordRendererCommandTrace = (
  context: RendererCausalTraceContext | null,
  event: RendererCausalTraceEventInput,
): boolean => {
  if (!context) return false;
  try {
    return rendererCausalTrace.record(context, event);
  } catch {
    return false;
  }
};

/** Creates an owner lifecycle context without exposing command payloads to the trace Module. */
export const beginRendererOwnerTrace = (
  input: Parameters<typeof createRendererCausalTraceContext>[0],
  trace: RendererCausalTrace = rendererCausalTrace,
): RendererCausalTraceContext | null => {
  if (!trace.enabled) return null;
  try {
    return createRendererCausalTraceContext(input);
  } catch {
    return null;
  }
};

/** Owner hook for emitting lifecycle proof without making diagnostics semantic authority. */
export const recordRendererOwnerTrace = (
  context: RendererCausalTraceContext | null,
  event: RendererCausalTraceEventInput,
  trace: RendererCausalTrace = rendererCausalTrace,
): boolean => {
  if (!context) return false;
  try {
    const renderToken = event.renderToken ?? null;
    const alreadyRecordedByTransport =
      event.kind !== "submitted" &&
      trace
        .snapshot()
        .events.some(
          (candidate) =>
            candidate.operationIdentityHash === context.operationIdentityHash &&
            candidate.kind === event.kind &&
            candidate.reason === event.reason &&
            candidate.renderToken === renderToken,
        );
    if (alreadyRecordedByTransport) return false;
    return trace.record(context, event);
  } catch {
    return false;
  }
};
