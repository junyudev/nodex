import {
  beginRendererOwnerTrace,
  recordRendererOwnerTrace,
  type RendererCausalTrace,
  type RendererCausalTraceContext,
  type RendererCausalTraceScopeKind,
} from "./renderer-causal-trace";

export interface LatestReturnedValueSnapshot<Value extends object> {
  readonly value: Value;
  readonly pending: boolean;
  /** Identifies the exact presented value awaiting React's layout handoff. */
  readonly renderToken: number | null;
}

export interface LatestReturnedValueOwner<Value extends object, Input = Value> {
  readonly getSnapshot: () => LatestReturnedValueSnapshot<Value>;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads canonical state without allowing a pre-intent response to overwrite newer intent. */
  readonly readCanonical: () => Promise<Value>;
  /** Presents the complete desired value synchronously, before entering the transport Port. */
  readonly update: (input: Input) => Promise<Value>;
  /** Completes only the current presentation token; stale handoffs are ignored. */
  readonly markRendered: (renderToken: number) => void;
}

export interface LatestReturnedValuePort<Value extends object, Input = Value> {
  readonly read: () => Promise<Value>;
  readonly update: (input: Input, trace: RendererCausalTraceContext | null) => Promise<Value>;
}

interface ReturnedValueIntent {
  readonly sequence: number;
  readonly trace: RendererCausalTraceContext | null;
  presentationToken: number;
  rendered: boolean;
  resultReceived: boolean;
}

interface RenderCandidate {
  readonly intentSequence: number;
  readonly token: number;
}

/**
 * Owns a latest-wins Main setting from local intent through returned canonical value and render.
 * Read responses are fenced by the intent generation at which they started, so a late read can
 * never resurrect state that predates a newer local choice.
 */
export function createLatestReturnedValueOwner<Value extends object, Input = Value>({
  initialValue,
  equals,
  operationId,
  port,
  project,
  semanticKey,
  owner,
  scopeKind,
  trace,
}: {
  readonly initialValue: Value;
  readonly equals: (left: Value, right: Value) => boolean;
  readonly operationId: () => string;
  readonly port: LatestReturnedValuePort<Value, Input>;
  /** Projects the complete local value before the transport boundary is entered. */
  readonly project: (current: Value, input: Input) => Value;
  readonly semanticKey: string;
  readonly owner: string;
  readonly scopeKind: RendererCausalTraceScopeKind;
  readonly trace?: RendererCausalTrace;
}): LatestReturnedValueOwner<Value, Input> {
  const listeners = new Set<() => void>();
  let intentSequence = 0;
  let nextRenderToken = 0;
  let activeIntent: ReturnedValueIntent | null = null;
  let renderCandidate: RenderCandidate | null = null;
  let stableValue = initialValue;
  let stableIntentSequence = 0;
  let presentedValue = initialValue;
  let snapshot: LatestReturnedValueSnapshot<Value> = {
    value: initialValue,
    pending: false,
    renderToken: null,
  };

  const refreshSnapshot = (): void => {
    const nextPending = activeIntent !== null;
    const nextRenderTokenValue = renderCandidate?.token ?? null;
    if (
      equals(snapshot.value, presentedValue) &&
      snapshot.pending === nextPending &&
      snapshot.renderToken === nextRenderTokenValue
    ) {
      return;
    }
    snapshot = {
      value: presentedValue,
      pending: nextPending,
      renderToken: nextRenderTokenValue,
    };
    for (const listener of listeners) listener();
  };

  const installPresentation = (intent: ReturnedValueIntent, value: Value): void => {
    nextRenderToken += 1;
    intent.presentationToken = nextRenderToken;
    intent.rendered = false;
    presentedValue = value;
    renderCandidate = { intentSequence: intent.sequence, token: nextRenderToken };
    refreshSnapshot();
  };

  const settleIfRendered = (intent: ReturnedValueIntent): void => {
    if (activeIntent !== intent || !intent.resultReceived || !intent.rendered) return;
    recordRendererOwnerTrace(
      intent.trace,
      { kind: "rendered", reason: "render_handoff", renderToken: intent.presentationToken },
      trace,
    );
    recordRendererOwnerTrace(intent.trace, { kind: "settled", reason: "proof_complete" }, trace);
    activeIntent = null;
    refreshSnapshot();
  };

  const readCanonical = async (): Promise<Value> => {
    const readStartedWithIntent = activeIntent !== null;
    const readGeneration = intentSequence;
    const value = await port.read();
    if (readStartedWithIntent || readGeneration !== intentSequence || activeIntent) return value;
    stableValue = value;
    stableIntentSequence = intentSequence;
    presentedValue = value;
    refreshSnapshot();
    return value;
  };

  const update = async (input: Input): Promise<Value> => {
    const desired = project(presentedValue, input);
    if (activeIntent) {
      recordRendererOwnerTrace(
        activeIntent.trace,
        { kind: "superseded", reason: "newer_intent" },
        trace,
      );
    }

    intentSequence += 1;
    const intent: ReturnedValueIntent = {
      sequence: intentSequence,
      trace: beginRendererOwnerTrace(
        {
          semanticKey,
          operationIdentity: operationId(),
          owner,
          protocol: "returned_value",
          scopeKind,
        },
        trace,
      ),
      presentationToken: 0,
      rendered: false,
      resultReceived: false,
    };
    activeIntent = intent;
    installPresentation(intent, desired);
    recordRendererOwnerTrace(intent.trace, { kind: "local_intent", reason: "local_intent" }, trace);

    let result: Value;
    try {
      result = await port.update(input, intent.trace);
    } catch (cause) {
      if (activeIntent !== intent) return presentedValue;
      activeIntent = null;
      if (renderCandidate?.intentSequence === intent.sequence) renderCandidate = null;
      presentedValue = stableValue;
      recordRendererOwnerTrace(
        intent.trace,
        { kind: "failed", reason: "transport_failure" },
        trace,
      );
      refreshSnapshot();
      throw cause;
    }

    const advancesStableValue = intent.sequence > stableIntentSequence;
    if (advancesStableValue) {
      stableValue = result;
      stableIntentSequence = intent.sequence;
    }
    if (activeIntent !== intent) {
      if (!activeIntent && advancesStableValue) {
        presentedValue = result;
        renderCandidate = null;
        refreshSnapshot();
      }
      return presentedValue;
    }
    intent.resultReceived = true;
    recordRendererOwnerTrace(intent.trace, { kind: "result", reason: "transport_result" }, trace);
    if (!equals(presentedValue, result)) installPresentation(intent, result);
    recordRendererOwnerTrace(
      intent.trace,
      {
        kind: "materialized",
        reason: "canonical_observation",
        renderToken: intent.presentationToken,
      },
      trace,
    );
    settleIfRendered(intent);
    return result;
  };

  const markRendered = (renderToken: number): void => {
    if (renderCandidate?.token !== renderToken) return;
    const intent = activeIntent;
    if (!intent || intent.sequence !== renderCandidate.intentSequence) return;
    renderCandidate = null;
    intent.rendered = true;
    settleIfRendered(intent);
    refreshSnapshot();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readCanonical,
    update,
    markRendered,
  };
}
