import { act, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { LibraryRouteTarget } from "../../shared/library-module";
import type {
  LocalProjectionScope,
  ProjectionScope,
  ProjectionStreamMessage,
} from "../../shared/projection-stream";
import type { ResourceLocationReadModel } from "../../shared/resource-locations";
import { render } from "../test/dom";
import { TestQueryProvider } from "../test/query";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";
import {
  resourceLocationTargetKey,
  useResourceLocation,
  useResourceLocations,
} from "./resource-location-queries";

const mocks = vi.hoisted(() => ({ resolveResourceLocation: vi.fn() }));

vi.mock("./api", () => ({
  readLibraryModule: vi.fn().mockResolvedValue({
    ok: true,
    value: {
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq: 0,
      value: { kind: "metadata" },
    },
  }),
  resolveResourceLocation: mocks.resolveResourceLocation,
}));

const card: LibraryRouteTarget = { kind: "page", pageId: "page:card" };
const note: LibraryRouteTarget = { kind: "page", pageId: "page:note" };
const space: ProjectionScope = { kind: "library", libraryId: "library-1" };

/** A committed Library change as the projection stream delivers it. */
function effect(
  commitSeq: number,
  pageIds: string[],
  databaseIds: string[],
  effectScope: LocalProjectionScope,
): ProjectionStreamMessage {
  const stream = { storeEpoch: "epoch-1", commitSeq };
  return {
    version: 2,
    kind: "effect",
    scope: space,
    stream,
    delivery: {
      ...stream,
      manifestHash: "b".repeat(64),
      operationId: `operation-${commitSeq}`,
      committedAt: "2026-08-06T00:00:00.000Z",
      impact: {
        kind: "resources",
        page_ids: pageIds,
        database_ids: databaseIds,
        data_source_ids: [],
        view_ids: [],
        document_heads: [],
      },
      effect: {
        scope: {
          schema_version: 1,
          canonical_key: "library:library-1",
          scope: effectScope,
        },
        baseRevision: commitSeq - 1,
        resultRevision: commitSeq,
        coveredCommitSeq: commitSeq,
        patch: null,
        requiresReadAtLeast: true,
        effectHash: "a".repeat(64),
      },
    },
  };
}

function locationText(location: ResourceLocationReadModel | null | undefined): string {
  if (location?.status !== "available") return location?.status ?? "pending";
  return location.segments
    .map((segment) =>
      segment.kind === "database" && segment.primaryProjectId
        ? segment.primaryProjectId
        : segment.title,
    )
    .join(" / ");
}

function LocationReaders() {
  const one = useResourceLocation(card);
  const many = useResourceLocations([card, card]);
  // A later reader with its own trail shares the family consumer with the first.
  const other = useResourceLocation(note);
  return (
    <>
      <output aria-label="Single location">{locationText(one.data)}</output>
      <output aria-label="Multiple locations">
        {locationText(many.get(resourceLocationTargetKey(card)))}
      </output>
      <output aria-label="Other location">{locationText(other.data)}</output>
    </>
  );
}

test("single and multiple readers share a route-free location and refresh on owner changes", async () => {
  const listeners = new Set<(message: ProjectionStreamMessage) => void>();
  const scopes: ProjectionScope[] = [];
  const registry = new ProjectionInvalidationRegistry({
    subscribeProjection: (scope, listener) => {
      scopes.push(scope);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  let commitSeq = 1;
  let parentTitle = "Host";
  let primaryProjectId: string | null = "Project Codex";
  let noteHostTitle = "Notes host";
  mocks.resolveResourceLocation.mockImplementation(
    async (target: LibraryRouteTarget): Promise<ResourceLocationReadModel> =>
      target.kind === "page" && target.pageId === note.pageId
        ? {
            status: "available",
            target: note,
            libraryId: space.libraryId,
            storeEpoch: "epoch-1",
            commitSeq,
            segments: [
              {
                kind: "page",
                pageId: "page:notes-host",
                title: noteHostTitle,
                lifecycle: "active",
              },
            ],
          }
        : {
            status: "available",
            target: card,
            libraryId: space.libraryId,
            storeEpoch: "epoch-1",
            commitSeq,
            segments: [
              { kind: "page", pageId: "page:host", title: parentTitle, lifecycle: "active" },
              {
                kind: "database",
                databaseId: "database:cards",
                title: "Cards",
                defaultViewId: "view:cards",
                primaryProjectId,
              },
            ],
          },
  );
  const view = render(
    <TestQueryProvider projectionRegistry={registry}>
      <LocationReaders />
    </TestQueryProvider>,
  );
  const sharedLocation = (expected: string) =>
    waitFor(() => {
      expect(view.getByLabelText("Single location").textContent).toBe(expected);
      expect(view.getByLabelText("Multiple locations").textContent).toBe(expected);
    });
  await sharedLocation("Host / Project Codex");
  await waitFor(() => expect(view.getByLabelText("Other location").textContent).toBe("Notes host"));
  expect(scopes).toEqual([space]);
  const reads = (target: LibraryRouteTarget) =>
    mocks.resolveResourceLocation.mock.calls.filter(([read]) => read === target).length;
  expect(reads(card)).toBe(1);
  expect(reads(note)).toBe(1);

  const refresh = (
    pageIds: string[],
    databaseIds: string[],
    effectScope: LocalProjectionScope = { kind: "library", library_id: space.libraryId },
  ) =>
    act(async () => {
      commitSeq += 1;
      for (const listener of listeners)
        listener(effect(commitSeq, pageIds, databaseIds, effectScope));
      await Promise.resolve();
    });

  parentTitle = "Renamed Host";
  await refresh(["page:host"], []);
  await sharedLocation("Renamed Host / Project Codex");

  primaryProjectId = null;
  await refresh([], ["database:cards"]);
  await sharedLocation("Renamed Host / Cards");

  // A Page-scoped title change on the later reader's trail reaches it too.
  noteHostTitle = "Renamed notes host";
  await refresh(["page:notes-host"], [], {
    kind: "page",
    project_id: "project-1",
    page_id: "page:notes-host",
  });
  await waitFor(() =>
    expect(view.getByLabelText("Other location").textContent).toBe("Renamed notes host"),
  );
  expect(reads(card)).toBe(4);
});

function FreshReader() {
  return (
    <output aria-label="Fresh location">{locationText(useResourceLocation(note).data)}</output>
  );
}

test("a rename that lands before the first location read finishes still refreshes it", async () => {
  const listeners = new Set<(message: ProjectionStreamMessage) => void>();
  const registry = new ProjectionInvalidationRegistry({
    subscribeProjection: (_scope, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  let hostTitle = "Host";
  let releaseFirstRead: (() => void) | null = null;
  const location = (title: string): ResourceLocationReadModel => ({
    status: "available",
    target: note,
    libraryId: space.libraryId,
    storeEpoch: "epoch-1",
    commitSeq: 1,
    segments: [{ kind: "page", pageId: "page:host", title, lifecycle: "active" }],
  });
  mocks.resolveResourceLocation.mockReset();
  // The first read observes the trail before the rename and answers after it.
  mocks.resolveResourceLocation.mockImplementationOnce(
    () =>
      new Promise<ResourceLocationReadModel>((resolve) => {
        const observed = location(hostTitle);
        releaseFirstRead = () => resolve(observed);
      }),
  );
  mocks.resolveResourceLocation.mockImplementation(async () => location(hostTitle));
  const view = render(
    <TestQueryProvider projectionRegistry={registry}>
      <FreshReader />
    </TestQueryProvider>,
  );
  await waitFor(() => expect(releaseFirstRead).not.toBeNull());
  await waitFor(() => expect(listeners.size).toBe(1));

  hostTitle = "Renamed host";
  await act(async () => {
    for (const listener of listeners)
      listener(
        effect(2, ["page:host"], [], {
          kind: "page",
          project_id: "project-1",
          page_id: "page:host",
        }),
      );
    await Promise.resolve();
  });
  await act(async () => {
    releaseFirstRead?.();
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(view.getByLabelText("Fresh location").textContent).toBe("Renamed host"),
  );
});
