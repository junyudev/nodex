import { describe, expect, it } from "vite-plus/test";

import {
  createRendererCausalTrace,
  createRendererCausalTraceContext,
  recordRendererOwnerTrace,
  rendererCausalTraceEnabledForMode,
  type RendererCausalTraceContext,
  type RendererCausalTraceEventInput,
} from "./renderer-causal-trace";

const context = (
  operationIdentity: string,
  protocol: RendererCausalTraceContext["protocol"] = "receipt_fenced_projection",
): RendererCausalTraceContext =>
  createRendererCausalTraceContext({
    semanticKey: "workspace.project.update",
    operationIdentity,
    owner: "project-catalog",
    protocol,
    scopeKind: "project",
  });

const record = (
  trace: ReturnType<typeof createRendererCausalTrace>,
  operation: RendererCausalTraceContext,
  ...events: readonly RendererCausalTraceEventInput[]
): void => {
  for (const event of events) trace.record(operation, event);
};

describe("renderer causal trace", () => {
  it("keeps only allowlisted metadata in a fixed-capacity ring", () => {
    let time = 100;
    const trace = createRendererCausalTrace({
      enabled: true,
      capacity: 2,
      now: () => time++,
    });
    const rawOperationIdentity = "nodexop:v1:private-operation-identity";
    const operation = context(rawOperationIdentity);

    trace.record(
      { ...operation, payload: "must not escape" } as RendererCausalTraceContext,
      { kind: "submitted", reason: "transport_submit", payload: "also private" } as never,
    );
    record(
      trace,
      operation,
      { kind: "acknowledged", reason: "committed" },
      { kind: "result", reason: "transport_result" },
    );

    const snapshot = trace.snapshot();
    expect(snapshot).toMatchObject({ capacity: 2, droppedEventCount: 1 });
    expect(snapshot.events[0]).toMatchObject({
      semanticKey: "workspace.project.update",
      operationIdentityHash: operation.operationIdentityHash,
      owner: "project-catalog",
      protocol: "receipt_fenced_projection",
      scopeKind: "project",
    });
    expect(
      snapshot.events.map(({ kind, sequence, timestamp }) => ({ kind, sequence, timestamp })),
    ).toEqual([
      { kind: "acknowledged", sequence: 2, timestamp: 101 },
      { kind: "result", sequence: 3, timestamp: 102 },
    ]);
    expect(operation.operationIdentityHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(context(rawOperationIdentity).operationIdentityHash).toBe(
      operation.operationIdentityHash,
    );
    expect(context(`${rawOperationIdentity}-other`).operationIdentityHash).not.toBe(
      operation.operationIdentityHash,
    );
    expect(JSON.stringify(snapshot)).not.toContain(rawOperationIdentity);
    expect(JSON.stringify(snapshot)).not.toContain("must not escape");
    expect(() =>
      trace.record(operation, { kind: "submitted", reason: "private user content" } as never),
    ).toThrow("trace event kind/reason is invalid");
    expect(JSON.stringify(trace.snapshot())).not.toContain("private user content");
    expect(trace.reduce().historyComplete).toBe(false);
  });

  it("accepts acknowledgement and materialization in either order", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 32, now: () => 1 });
    const ackFirst = context("operation-ack-first");
    const materializedFirst = context("operation-materialized-first");

    record(
      trace,
      ackFirst,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "committed" },
      { kind: "materialized", reason: "canonical_observation", renderToken: 11 },
      { kind: "rendered", reason: "render_handoff", renderToken: 11 },
      { kind: "settled", reason: "proof_complete" },
    );
    record(
      trace,
      materializedFirst,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "materialized", reason: "canonical_observation", renderToken: 22 },
      { kind: "rendered", reason: "render_handoff", renderToken: 22 },
      { kind: "acknowledged", reason: "committed" },
      { kind: "settled", reason: "proof_complete" },
    );

    const reduction = trace.reduce();
    expect(reduction.legal).toBe(true);
    expect(reduction.operations.map(({ outcome }) => outcome)).toEqual(["settled", "settled"]);
  });

  it("rejects settlement without protocol-required proof and exact rendered handoff", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 16, now: () => 1 });
    const missingProof = context("operation-missing-proof");
    const wrongRender = context("operation-wrong-render");

    record(
      trace,
      missingProof,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "committed" },
      { kind: "settled", reason: "proof_complete" },
    );
    record(
      trace,
      wrongRender,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "materialized", reason: "canonical_observation", renderToken: 7 },
      { kind: "rendered", reason: "render_handoff", renderToken: 8 },
      { kind: "acknowledged", reason: "committed" },
      { kind: "settled", reason: "proof_complete" },
    );

    expect(trace.reduce().violations.map(({ code }) => code)).toEqual([
      "missing_materialization",
      "missing_render",
      "render_token_mismatch",
      "missing_render",
    ]);
  });

  it("rejects proof observed before submission and local intent recorded too late", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 8, now: () => 1 });
    const operation = context("operation-invalid-order");

    record(
      trace,
      operation,
      { kind: "materialized", reason: "canonical_observation", renderToken: 4 },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "local_intent", reason: "local_intent" },
    );

    expect(trace.reduce().violations.map(({ code }) => code)).toEqual([
      "missing_submission",
      "missing_local_intent",
      "late_local_intent",
    ]);
  });

  it("rejects submission when the owner did not first present local intent", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 4, now: () => 1 });
    const operation = context("operation-without-local-intent", "returned_value");

    record(trace, operation, { kind: "submitted", reason: "transport_submit" });

    expect(trace.reduce().violations.map(({ code }) => code)).toEqual(["missing_local_intent"]);
  });

  it("accepts ignored transport completion after a newer intent supersedes presentation", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 8, now: () => 1 });
    const operation = context("operation-superseded-in-flight", "returned_value");

    record(
      trace,
      operation,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "superseded", reason: "newer_intent" },
      { kind: "result", reason: "terminal_result" },
    );

    expect(trace.reduce()).toMatchObject({
      legal: true,
      operations: [{ outcome: "superseded" }],
    });
  });

  it("requires an accepted pending operation to observe a terminal result before settlement", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 16, now: () => 1 });
    const incomplete = context("operation-pending-incomplete", "pending_operation");
    const complete = context("operation-pending-complete", "pending_operation");

    record(
      trace,
      incomplete,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "result", reason: "transport_result" },
      { kind: "pending", reason: "accepted_pending" },
      { kind: "settled", reason: "proof_complete" },
    );
    record(
      trace,
      complete,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "pending", reason: "accepted_pending" },
      { kind: "result", reason: "terminal_result" },
      { kind: "settled", reason: "proof_complete" },
    );

    const reduction = trace.reduce();
    expect(reduction.violations.map(({ code }) => code)).toEqual(["missing_result"]);
    expect(reduction.operations.map(({ outcome }) => outcome)).toEqual(["settled", "settled"]);
  });

  it("retains explicit no-op, failed, superseded, revoked, and pending outcomes", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 32, now: () => 1 });
    const outcomes = [
      ["no-op", { kind: "no_op", reason: "no_op" }],
      ["failed", { kind: "failed", reason: "domain_failure" }],
      ["superseded", { kind: "superseded", reason: "newer_intent" }],
      ["revoked", { kind: "revoked", reason: "authority_revoked" }],
      ["pending", { kind: "pending", reason: "accepted_pending" }],
    ] as const;

    for (const [identity, outcome] of outcomes) {
      const operation = context(
        identity,
        outcome.kind === "pending" ? "pending_operation" : undefined,
      );
      record(
        trace,
        operation,
        { kind: "local_intent", reason: "local_intent" },
        { kind: "submitted", reason: "transport_submit" },
        outcome,
      );
    }
    record(trace, context("failed"), { kind: "result", reason: "transport_result" });

    const reduction = trace.reduce();
    expect(reduction.operations.map(({ outcome }) => outcome)).toEqual([
      "no_op",
      "failed",
      "superseded",
      "revoked",
      "pending",
    ]);
    expect(reduction.violations.map(({ code }) => code)).toEqual(["event_after_terminal"]);
  });

  it("allows an exact retry after an uncertain transport failure", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 16, now: () => 1 });
    const operation = context("operation-uncertain-retry");

    record(
      trace,
      operation,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "failed", reason: "transport_failure" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "committed" },
      { kind: "materialized", reason: "canonical_observation", renderToken: 9 },
      { kind: "rendered", reason: "render_handoff", renderToken: 9 },
      { kind: "settled", reason: "proof_complete" },
    );

    expect(trace.reduce()).toMatchObject({
      legal: true,
      operations: [{ outcome: "settled" }],
    });
  });

  it("coalesces owner proof already emitted by the typed transport", () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 8, now: () => 1 });
    const operation = context("operation-shared-boundary");
    record(
      trace,
      operation,
      { kind: "local_intent", reason: "local_intent" },
      { kind: "submitted", reason: "transport_submit" },
      { kind: "failed", reason: "domain_failure" },
    );

    expect(
      recordRendererOwnerTrace(operation, { kind: "failed", reason: "domain_failure" }, trace),
    ).toBe(false);
    expect(trace.snapshot().events.map(({ kind }) => kind)).toEqual([
      "local_intent",
      "submitted",
      "failed",
    ]);
    expect(trace.reduce()).toMatchObject({ legal: true, operations: [{ outcome: "failed" }] });
  });

  it("maps production mode to a disabled no-op trace", () => {
    expect(rendererCausalTraceEnabledForMode("development")).toBe(true);
    expect(rendererCausalTraceEnabledForMode("production")).toBe(false);

    const trace = createRendererCausalTrace({ enabled: false, capacity: 4 });
    expect(
      trace.record(context("production-operation"), {
        kind: "submitted",
        reason: "transport_submit",
      }),
    ).toBe(false);
    expect(trace.snapshot()).toEqual({ capacity: 4, droppedEventCount: 0, events: [] });
    expect(trace.reduce()).toMatchObject({ historyComplete: true, legal: true, operations: [] });
  });
});
