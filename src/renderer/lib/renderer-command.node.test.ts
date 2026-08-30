import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  beginTrace: vi.fn(),
  invoke: vi.fn(),
  recordTrace: vi.fn(),
}));

vi.mock("./api", () => ({
  CoreApiError: class CoreApiError extends Error {
    constructor(readonly detail: { readonly message: string }) {
      super(detail.message);
    }
  },
}));

vi.mock("./local-commit-ingress", () => ({
  admitLocalCommitApply: mocks.admit,
}));

vi.mock("./renderer-causal-trace", () => ({
  beginRendererCommandTrace: mocks.beginTrace,
  recordRendererCommandTrace: mocks.recordTrace,
}));

import {
  defineLocalCommitRendererCommand,
  defineRendererCommand,
  invokeLocalCommitCommand,
  invokePlainCommand,
  invokePlainCommandWithTrace,
  invokeRevisionedCommand,
} from "./renderer-command";

const traceContext = {
  semanticKey: "workspace.project.update.test",
  operationIdentityHash: "f".repeat(64),
  owner: "project-catalog-test",
  protocol: "receipt_fenced_projection" as const,
  scopeKind: "project" as const,
};

const plainTraceContext = {
  ...traceContext,
  semanticKey: "codex.account.logout.test",
  owner: "codex-account-test",
  protocol: "returned_value" as const,
};

const pendingTraceContext = {
  ...traceContext,
  semanticKey: "shell.open_external_url.test",
  owner: "external-navigation-test",
  protocol: "pending_operation" as const,
};

const definition = defineLocalCommitRendererCommand({
  key: "workspace.project.update.test",
  channel: "projects:update",
  authority: "core",
  owner: "project-catalog-test",
  protocol: { kind: "receipt_fenced_projection", presentation: "required" },
});

const localPendingDefinition = defineLocalCommitRendererCommand({
  key: "workspace.project.update.pending.test",
  channel: "projects:update",
  authority: "core",
  owner: "project-catalog-test",
  protocol: { kind: "pending_operation" },
});

const acknowledgement = {
  status: "committed" as const,
  commit: {
    store_epoch: "epoch-1",
    commit_seq: 2,
    manifest_hash: "f".repeat(64),
  },
  delivery: null,
};

const plainDefinition = defineRendererCommand({
  key: "codex.account.logout.test",
  channel: "codex:account:logout",
  authority: "external",
  owner: "codex-account-test",
  protocol: { kind: "returned_value" },
});

const pendingDefinition = defineRendererCommand({
  key: "shell.open_external_url.test",
  channel: "shell:open-external-url",
  authority: "external",
  owner: "external-navigation-test",
  protocol: { kind: "pending_operation" },
});

const directRevisionDefinition = defineRendererCommand({
  key: "persisted_atom.update.test",
  channel: "persisted-atom:update",
  authority: "main",
  owner: "persisted-atom-test",
  protocol: { kind: "revision_fenced_local" },
});

describe("renderer command transport trace", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { api: { invoke: mocks.invoke } });
    mocks.admit.mockReset();
    mocks.beginTrace.mockReset().mockReturnValue(traceContext);
    mocks.invoke.mockReset();
    mocks.recordTrace.mockReset();
  });

  it("does not expose success until the exact apply evidence is admitted", async () => {
    let finishAdmission!: () => void;
    mocks.admit.mockReturnValue(
      new Promise<void>((resolve) => {
        finishAdmission = resolve;
      }),
    );
    mocks.invoke.mockResolvedValue({
      ok: true,
      value: { id: "project-1" },
      localCommit: acknowledgement,
    });

    let completed = false;
    const request = invokeLocalCommitCommand(definition, {
      operationId: "nodexop:v1:0:604800000:test:entropy",
      projectId: "project-1",
      updates: { name: "Renamed", expectedBindingRevision: 1 },
    }).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();

    expect(mocks.admit).toHaveBeenCalledWith(acknowledgement);
    expect(completed).toBe(false);
    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "committed" },
    ]);
    finishAdmission();
    await expect(request).resolves.toEqual({
      value: { id: "project-1" },
      acknowledgement,
    });
    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "committed" },
      { kind: "result", reason: "transport_result" },
    ]);
  });

  it("rejects malformed apply evidence before admission", async () => {
    mocks.invoke.mockResolvedValue({
      ok: true,
      value: { id: "project-1" },
      localCommit: { status: "committed", commit: { store_epoch: "", commit_seq: 0 } },
    });

    await expect(
      invokeLocalCommitCommand(definition, {
        operationId: "nodexop:v1:0:604800000:test:entropy",
        projectId: "project-1",
        updates: { name: "Renamed", expectedBindingRevision: 1 },
      }),
    ).rejects.toThrow("Local commit identity is invalid");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "failed", reason: "invalid_acknowledgement" },
    ]);
  });

  it("distinguishes delivery admission failure from transport failure", async () => {
    const cause = new Error("delivery ingress unavailable");
    mocks.admit.mockRejectedValue(cause);
    mocks.invoke.mockResolvedValue({
      ok: true,
      value: { id: "project-1" },
      localCommit: acknowledgement,
    });

    await expect(
      invokeLocalCommitCommand(definition, {
        operationId: "nodexop:v1:0:604800000:test:entropy",
        projectId: "project-1",
        updates: { name: "Renamed", expectedBindingRevision: 1 },
      }),
    ).rejects.toBe(cause);

    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "committed" },
      { kind: "failed", reason: "delivery_admission_failure" },
    ]);
  });

  it("raises a typed Core failure without admitting evidence", async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: {
        code: "not_found",
        message: "Project not found",
        retryable: false,
        recovery: { kind: "none" },
      },
    });

    await expect(
      invokeLocalCommitCommand(definition, {
        operationId: "nodexop:v1:0:604800000:test:entropy",
        projectId: "project-1",
        updates: { name: "Renamed", expectedBindingRevision: 1 },
      }),
    ).rejects.toThrow("Project not found");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "failed", reason: "domain_failure" },
    ]);
  });

  it("records no-op acknowledgement as an explicit outcome", async () => {
    const noOpAcknowledgement = {
      status: "no_op" as const,
      observed: { store_epoch: "epoch-1", commit_head: 2 },
    };
    mocks.admit.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue({
      ok: true,
      value: { id: "project-1" },
      localCommit: noOpAcknowledgement,
    });

    await invokeLocalCommitCommand(definition, {
      operationId: "nodexop:v1:0:604800000:test:entropy",
      projectId: "project-1",
      updates: { name: "Renamed", expectedBindingRevision: 1 },
    });

    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "no_op", reason: "no_op" },
      { kind: "result", reason: "transport_result" },
    ]);
  });

  it("records LocalCommit pending acceptance without inventing its terminal result", async () => {
    mocks.admit.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue({
      ok: true,
      value: { id: "project-1" },
      localCommit: acknowledgement,
    });

    await invokeLocalCommitCommand(localPendingDefinition, {
      operationId: "nodexop:v1:0:604800000:test:entropy",
      projectId: "project-1",
      updates: { name: "Renamed", expectedBindingRevision: 1 },
    });

    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "committed" },
      { kind: "pending", reason: "accepted_pending" },
    ]);
  });

  it("does not invent a lifecycle for a plain command without owner context", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    await invokePlainCommand(plainDefinition);

    expect(mocks.beginTrace).not.toHaveBeenCalled();
    expect(mocks.recordTrace).not.toHaveBeenCalled();
  });

  it("records transport evidence on the owner-supplied operation context", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    await invokePlainCommandWithTrace(plainDefinition, plainTraceContext);

    expect(mocks.beginTrace).not.toHaveBeenCalled();
    expect(mocks.recordTrace.mock.calls.map(([context, event]) => [context, event])).toEqual([
      [plainTraceContext, { kind: "submitted", reason: "transport_submit" }],
      [plainTraceContext, { kind: "result", reason: "terminal_result" }],
    ]);
  });

  it("rejects an owner trace context from a different semantic command", async () => {
    await expect(invokePlainCommandWithTrace(plainDefinition, traceContext)).rejects.toThrow(
      "trace context does not match",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("records an accepted pending operation without inventing terminal completion", async () => {
    mocks.invoke.mockResolvedValue(true);

    await invokePlainCommandWithTrace(
      pendingDefinition,
      pendingTraceContext,
      "https://example.com",
    );

    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "pending", reason: "accepted_pending" },
    ]);
  });

  it("records plain command transport failure without reclassifying the cause", async () => {
    const cause = new TypeError("preload bridge unavailable");
    mocks.invoke.mockRejectedValue(cause);

    await expect(invokePlainCommandWithTrace(plainDefinition, plainTraceContext)).rejects.toBe(
      cause,
    );

    expect(mocks.recordTrace.mock.calls.map(([, event]) => event)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "failed", reason: "transport_failure" },
    ]);
  });

  it("accepts a direct revision acknowledgement", async () => {
    const event = {
      key: "layout",
      value: { panel: "right" },
      mutationId: "mutation-1",
      revision: 7,
      originRendererId: "renderer-1",
    };
    mocks.invoke.mockResolvedValue(event);

    await expect(
      invokeRevisionedCommand(directRevisionDefinition, {
        key: event.key,
        value: event.value,
        mutationId: event.mutationId,
      }),
    ).resolves.toEqual(event);
    expect(mocks.recordTrace.mock.calls.map(([, traceEvent]) => traceEvent)).toEqual([
      { kind: "submitted", reason: "transport_submit" },
      { kind: "acknowledged", reason: "revision_accepted" },
      { kind: "result", reason: "transport_result" },
    ]);
  });

  it("rejects a malformed direct revision acknowledgement", async () => {
    mocks.invoke.mockResolvedValue({ key: "layout", value: true });

    await expect(
      invokeRevisionedCommand(directRevisionDefinition, {
        key: "layout",
        value: true,
        mutationId: "mutation-2",
      }),
    ).rejects.toThrow("Revisioned command acknowledgement is invalid");
  });
});
