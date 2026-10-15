import { act, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import type { ProjectionScope, ProjectionStreamMessage } from "../../shared/projection-stream";
import { render } from "../test/dom";
import {
  ProjectionInvalidationProvider,
  useProjectionRegistration,
} from "./projection-invalidation-context";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";

const scope: ProjectionScope = {
  kind: "library",
  libraryId: "library-1",
};

const checkpoint = (commitSeq: number): ProjectionStreamMessage => ({
  version: 2,
  kind: "checkpoint",
  scope,
  stream: { storeEpoch: "epoch-1", commitSeq },
});

const pageEffect = (pageId: string, commitSeq: number): ProjectionStreamMessage => ({
  version: 2,
  kind: "effect",
  scope,
  stream: { storeEpoch: "epoch-1", commitSeq },
  delivery: {
    storeEpoch: "epoch-1",
    commitSeq,
    manifestHash: "a".repeat(64),
    operationId: `operation-${commitSeq}`,
    committedAt: "2026-08-10T00:00:00.000Z",
    impact: {
      kind: "resources",
      page_ids: [pageId],
      database_ids: [],
      data_source_ids: [],
      view_ids: [],
      document_heads: [],
    },
    effect: {
      scope: {
        schema_version: 1,
        canonical_key: `page:${pageId}`,
        scope: { kind: "page", project_id: "project-1", page_id: pageId },
      },
      baseRevision: commitSeq - 1,
      resultRevision: commitSeq,
      coveredCommitSeq: commitSeq,
      patch: { kind: "page_changed", projectId: "project-1", pageId },
      requiresReadAtLeast: true,
      effectHash: "b".repeat(64),
    },
  },
});

function RegistrationHarness({
  invalidate,
  pageId,
}: {
  readonly invalidate: () => void;
  readonly pageId: string;
}) {
  useProjectionRegistration({
    scope,
    consumerKey: "react-query",
    getDependencies: () => ({ pageIds: [pageId] }),
    getCursor: () => null,
    invalidate,
  });
  return null;
}

describe("useProjectionRegistration", () => {
  test("preserves checkpoint state when a render replaces query payload objects", async () => {
    const listeners = new Set<(message: ProjectionStreamMessage) => void>();
    const registry = new ProjectionInvalidationRegistry({
      subscribeProjection: (_scope, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const releaseKeeper = registry.register({
      scope,
      consumerKey: "keeper",
      getDependencies: () => ({ aggregate: true }),
      getCursor: () => ({ storeEpoch: "epoch-1", commitSeq: 1 }),
      invalidate: () => undefined,
    });
    for (const listener of listeners) listener(checkpoint(2));

    const invalidate = vi.fn();
    const tree = (pageId: string) => (
      <ProjectionInvalidationProvider registry={registry}>
        <RegistrationHarness invalidate={invalidate} pageId={pageId} />
      </ProjectionInvalidationProvider>
    );
    const view = render(tree("page-1"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());

    view.rerender(tree("page-2"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(invalidate).toHaveBeenCalledOnce();
    releaseKeeper();
  });

  test("keeps one semantic subscription while callbacks observe current data", async () => {
    const listeners = new Set<(message: ProjectionStreamMessage) => void>();
    const subscribeProjection = vi.fn(
      (_scope, listener: (message: ProjectionStreamMessage) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    );
    const registry = new ProjectionInvalidationRegistry({
      subscribeProjection,
    });
    const invalidate = vi.fn();
    const tree = (pageId: string) => (
      <ProjectionInvalidationProvider registry={registry}>
        <RegistrationHarness invalidate={invalidate} pageId={pageId} />
      </ProjectionInvalidationProvider>
    );
    const view = render(tree("page-1"));
    await waitFor(() => expect(subscribeProjection).toHaveBeenCalledOnce());

    view.rerender(tree("page-2"));
    await act(async () => {
      for (const listener of listeners) listener(pageEffect("page-2", 2));
      await Promise.resolve();
    });

    expect(subscribeProjection).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
