import { expect, test, vi } from "vite-plus/test";
import type {
  LocalProjectionScope,
  ProjectionScope,
  ProjectionStreamMessage,
} from "../../../../shared/projection-stream";
import { coreHistoryReconciliation } from "./nfm-history-reconciliation";

const { subscribe } = vi.hoisted(() => ({
  subscribe: vi.fn<
    (scope: ProjectionScope, listener: (message: ProjectionStreamMessage) => void) => () => void
  >(() => vi.fn()),
}));
vi.mock("../../../lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({ subscribeProjectionStream: subscribe }),
}));
vi.mock("../../../lib/api", () => ({ readLibraryModule: vi.fn() }));

const message = (scope: LocalProjectionScope): ProjectionStreamMessage => ({
  version: 2,
  kind: "effect",
  scope: { kind: "library", libraryId: "library" },
  stream: { storeEpoch: "epoch", commitSeq: 1 },
  delivery: {
    storeEpoch: "epoch",
    commitSeq: 1,
    manifestHash: "a".repeat(64),
    operationId: "release",
    committedAt: "2026-09-08T00:00:00Z",
    impact: { kind: "all" },
    effect: {
      scope: { schema_version: 1, canonical_key: "history", scope },
      baseRevision: 0,
      resultRevision: 1,
      coveredCommitSeq: 1,
      patch: null,
      requiresReadAtLeast: true,
      effectHash: "b".repeat(64),
    },
  },
});

test("Library history repairs on Library-scope releases without broadening a Project subscription", () => {
  const libraryInvalidated = vi.fn();
  const projectInvalidated = vi.fn();
  const scope = { libraryId: "library", storeEpoch: "epoch" };
  const stopLibrary = coreHistoryReconciliation.subscribe(
    { ...scope, accessContext: { kind: "library" } },
    libraryInvalidated,
  );
  const stopProject = coreHistoryReconciliation.subscribe(
    { ...scope, accessContext: { kind: "project", projectId: "project" } },
    projectInvalidated,
  );
  const libraryListener = subscribe.mock.calls[0]![1];
  const projectListener = subscribe.mock.calls[1]![1];
  libraryListener(message({ kind: "library", library_id: "library" }));
  projectListener(message({ kind: "library", library_id: "library" }));
  expect(libraryInvalidated).toHaveBeenCalledTimes(1);
  expect(projectInvalidated).not.toHaveBeenCalled();
  projectListener(message({ kind: "structural_history", project_id: "project" }));
  expect(projectInvalidated).toHaveBeenCalledTimes(1);
  stopLibrary();
  stopProject();
});
