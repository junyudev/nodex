import { expect, test, vi } from "vite-plus/test";
import type {
  BlockDocumentSurfaceRuntime,
  BlockDocumentSurfaceStatus,
} from "./block-document-surface-runtime";
import type { CanvasSceneProvider, CanvasSceneProviderStatus } from "./canvas-scene-provider";
import { observeDocumentContentIssues } from "./document-content-issues";
import { observeCanvasContentIssues } from "./canvas-content-issues";
import { contentEditIssues, contentRecoveryIssueId } from "./content-edit-issues";
import { createPageDocument } from "../../shared/block-documents";

const scope = {
  libraryId: "library",
  accessContext: { kind: "project" as const, projectId: "project" },
  storeEpoch: "epoch",
  documentId: "document",
  ownerBlockId: "page",
  generation: 1,
};

test("a retained Page reports only actionable saves and clears after acknowledgement", async () => {
  vi.useFakeTimers();
  const { document } = createPageDocument({
    documentId: scope.documentId,
    initialTitle: "Research notes",
  });
  let status = {
    phase: "ready",
    provider: {
      phase: "synced",
      pendingUpdateCount: 0,
      checkpoint: { phase: "ready", failureCount: 0 },
    },
  } as BlockDocumentSurfaceStatus;
  const listeners = new Set<() => void>();
  const connect = vi.fn();
  const runtime = {
    descriptor: scope,
    document,
    getStatus: () => status,
    connect,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as BlockDocumentSurfaceRuntime;
  const release = observeDocumentContentIssues(runtime);
  const publish = (provider: Partial<BlockDocumentSurfaceStatus["provider"]>) => {
    status = { ...status, provider: { ...status.provider, ...provider } };
    listeners.forEach((listener) => listener());
  };
  try {
    publish({ phase: "saving", pendingUpdateCount: 1 });
    await vi.advanceTimersByTimeAsync(7999);
    expect(contentEditIssues.getSnapshot()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const issue = contentEditIssues.getSnapshot()[0]!;
    expect(issue.scope.accessContext).toEqual(scope.accessContext);
    expect(issue.location).toEqual({
      target: { kind: "page", pageId: "page" },
      label: "Research notes",
    });
    const retry = issue.actions[0]!;
    if (retry.kind !== "run") throw new Error("Expected owner retry");
    await retry.run();
    expect(connect).toHaveBeenCalledOnce();
    publish({ phase: "synced", pendingUpdateCount: 0 });
    expect(contentEditIssues.getSnapshot()).toEqual([]);
  } finally {
    release();
    document.destroy();
    vi.useRealTimers();
  }
  expect(listeners.size).toBe(0);
});

test("a Canvas problem and its retained request use the same draft identity", async () => {
  let status: CanvasSceneProviderStatus = {
    phase: "ready",
    connected: true,
    headSeq: 1,
    pendingMutationCount: 0,
    writeFrozen: false,
  };
  const listeners = new Set<() => void>();
  const checkpointRecovery = vi.fn(async () => {});
  const provider = {
    getStatus: () => status,
    checkpointRecovery,
    subscribeStatus: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as CanvasSceneProvider;
  const release = observeCanvasContentIssues(provider, scope);
  try {
    expect(contentEditIssues.getSnapshot()).toEqual([]);
    status = {
      ...status,
      phase: "reset-required",
      pendingMutationCount: 1,
      inFlightMutationId: "mutation",
    };
    listeners.forEach((listener) => listener());
    const issue = contentEditIssues.getSnapshot()[0]!;
    expect(issue.id).toBe(
      contentRecoveryIssueId(
        { ...scope, accessContext: { kind: "library" } },
        "epoch",
        "canvas:document:mutation",
      ),
    );
    status = { ...status, pendingMutationCount: 0, inFlightMutationId: undefined };
    listeners.forEach((listener) => listener());
    expect(contentEditIssues.getSnapshot()[0]?.id).toBe(issue.id);
    const review = issue.actions[0]!;
    if (review.kind !== "review") throw new Error("Expected recovery review");
    expect(review.scope.accessContext).toEqual(scope.accessContext);
    await review.prepare?.();
    expect(checkpointRecovery).toHaveBeenCalledOnce();
  } finally {
    release();
  }
  expect(contentEditIssues.getSnapshot()).toEqual([]);
  expect(listeners.size).toBe(0);
});
