import { describe, expect, test, vi } from "vite-plus/test";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { ProjectionScope, ProjectionStreamMessage } from "../../shared/projection-stream";
import type { SessionLinkedPageSummaryResult } from "../../shared/types";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";
import { createSessionLinkedPageStore, type SessionLinkedPage } from "./session-linked-page";

const scope: ProjectionScope = { kind: "library", libraryId: "library:one" };
const page = (label = "Build"): SessionLinkedPage => ({
  pageId: "page:one",
  pageKey: "LAB-1",
  title: "Current title",
  status: { optionId: "build", label },
});
const result = (
  sessionIds: string[],
  value: SessionLinkedPage | null = page(),
  revision = 1,
): SessionLinkedPageSummaryResult => ({
  libraryId: "library:one",
  storeEpoch: "epoch:one",
  projectionRevision: revision,
  summaries: value ? sessionIds.map((sessionId) => ({ sessionId, page: value })) : [],
});
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fixture(checkpointOnSubscribe: number | null = null) {
  const sessionListeners = new Set<(event: ProjectSessionsChangeEvent) => void>();
  const projectionListeners = new Set<(event: ProjectionStreamMessage) => void>();
  const registry = new ProjectionInvalidationRegistry({
    subscribeProjection: (_scope, listener) => {
      projectionListeners.add(listener);
      if (checkpointOnSubscribe !== null)
        listener({
          version: 2,
          kind: "checkpoint",
          scope,
          stream: { storeEpoch: "epoch:one", commitSeq: checkpointOnSubscribe },
        });
      return () => projectionListeners.delete(listener);
    },
  });
  const read = vi.fn(async ({ sessionIds }: { sessionIds: string[] }) => result(sessionIds));
  const store = createSessionLinkedPageStore({
    read,
    subscribeSessions: (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    registerProjection: (registration) => registry.register(registration),
  });
  return {
    read,
    store,
    registry,
    sessionListeners,
    projectionListeners,
    sessionChange(
      sessionIds: string[],
      changeType: ProjectSessionsChangeEvent["changeType"] = "update",
    ) {
      for (const listener of sessionListeners)
        listener({
          summaryScopes: [],
          detailInvalidation: { kind: "sessions", sessionIds },
          changeType,
        });
    },
    projection(message: ProjectionStreamMessage) {
      for (const listener of projectionListeners) listener(message);
    },
  };
}

const statusEffect = (commitSeq: number): ProjectionStreamMessage => ({
  version: 2,
  kind: "effect",
  scope,
  stream: { storeEpoch: "epoch:one", commitSeq },
  delivery: {
    storeEpoch: "epoch:one",
    commitSeq,
    manifestHash: "a".repeat(64),
    operationId: `operation:${commitSeq}`,
    committedAt: "2026-10-28T00:00:00Z",
    impact: {
      kind: "resources",
      page_ids: ["page:one"],
      database_ids: [],
      data_source_ids: ["source:one"],
      view_ids: [],
      document_heads: [],
    },
    effect: {
      scope: {
        schema_version: 1,
        canonical_key: "source:one",
        scope: {
          kind: "page_detail_data_source",
          project_id: "project:one",
          database_id: "database:one",
          data_source_id: "source:one",
        },
      },
      baseRevision: commitSeq - 1,
      resultRevision: commitSeq,
      coveredCommitSeq: commitSeq,
      patch: null,
      requiresReadAtLeast: true,
      effectHash: "b".repeat(64),
    },
  },
});

describe("Session Linked Page store", () => {
  test("coalesces rows from different lanes, caches each Session, and releases shared subscriptions", async () => {
    const f = fixture();
    const releases = [
      f.store.subscribeSession("session:a", vi.fn()),
      f.store.subscribeSession("session:b", vi.fn()),
      f.store.subscribeSession("session:a", vi.fn()),
    ];
    expect(f.read).not.toHaveBeenCalled();
    await settle();
    expect(f.read).toHaveBeenCalledExactlyOnceWith({ sessionIds: ["session:a", "session:b"] });
    expect(f.store.read("session:a")).toEqual(page());
    expect(f.sessionListeners.size).toBe(1);
    expect(f.projectionListeners.size).toBe(1);
    releases.push(f.store.subscribeSession("session:a", vi.fn()));
    await settle();
    expect(f.read).toHaveBeenCalledOnce();
    releases.forEach((release) => release());
    await settle();
    expect(f.sessionListeners.size).toBe(0);
    expect(f.projectionListeners.size).toBe(0);
    f.registry.dispose();
  });

  test("chunks more than the Core bound into 200 and 1 without duplicate identities", async () => {
    const f = fixture(1);
    const releases = Array.from({ length: 201 }, (_, i) =>
      f.store.subscribeSession(`session:${i}`, () => {}),
    );
    await settle();
    expect(f.read.mock.calls.map(([input]) => input.sessionIds.length)).toEqual([200, 1]);
    expect(f.store.read("session:200")).toEqual(page());
    releases.forEach((release) => release());
    await settle();
    f.registry.dispose();
  });

  test("repairs a first snapshot older than the subscription checkpoint", async () => {
    const f = fixture(2);
    f.read.mockResolvedValueOnce(result(["session:a"], page("Build"), 1));
    f.read.mockResolvedValue(result(["session:a"], page("In progress"), 2));
    const release = f.store.subscribeSession("session:a", () => {});
    await vi.waitFor(() => expect(f.store.read("session:a")?.status?.label).toBe("In progress"));
    expect(f.read).toHaveBeenCalledTimes(2);
    release();
    await settle();
    f.registry.dispose();
  });

  test("supersedes an initial read when a link changes and coalesces the trailing read", async () => {
    const f = fixture();
    let resolveInitial!: (value: SessionLinkedPageSummaryResult) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );
    const release = f.store.subscribeSession("session:a", () => {});
    await settle();
    const otherLane = f.store.subscribeSession("session:a", () => {});
    f.sessionChange(["session:a"]);
    f.sessionChange(["session:a"]);
    f.read.mockResolvedValue(result(["session:a"], null, 2));
    resolveInitial(result(["session:a"]));
    await settle();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.store.read("session:a")).toBeNull();
    otherLane();
    release();
    await settle();
    f.registry.dispose();
  });

  test("refreshes Status labels through Library projection effects and ignores covered effects", async () => {
    const f = fixture();
    const release = f.store.subscribeSession("session:a", () => {});
    await settle();
    f.read.mockResolvedValue(result(["session:a"], page("In progress"), 2));
    f.projection(statusEffect(2));
    await vi.waitFor(() => expect(f.store.read("session:a")?.status?.label).toBe("In progress"));
    expect(f.read).toHaveBeenCalledTimes(2);
    f.projection(statusEffect(2));
    await settle();
    expect(f.read).toHaveBeenCalledTimes(2);
    release();
    await settle();
    f.registry.dispose();
  });

  test("refreshes absent results after restore and clears pages across stream resets", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(result(["session:a"], null));
    const release = f.store.subscribeSession("session:a", () => {});
    await settle();
    f.read.mockResolvedValue(result(["session:a"], page(), 2));
    f.projection(statusEffect(2));
    await vi.waitFor(() => expect(f.store.read("session:a")).toEqual(page()));
    f.read.mockResolvedValue(result(["session:a"], null, 3));
    f.projection({
      version: 2,
      kind: "reset",
      scope,
      stream: { storeEpoch: "epoch:one", commitSeq: 3 },
      reason: "reconnect",
    });
    expect(f.store.read("session:a")).toBeNull();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    release();
    await settle();
    f.registry.dispose();
  });
});
