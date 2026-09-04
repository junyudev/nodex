import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";

import type { OwnedDocumentDescriptor } from "../../../shared/block-documents/contracts";
import { PAGE_DOCUMENT_SCHEMA_VERSION } from "../../../shared/block-documents/page-document";
import type { DocumentVersionDetail } from "../../../shared/block-documents/document-history";
import type { PageHistoryEntry, PageHistoryPage } from "../../../shared/page-history";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { textContent } from "../../test/dom";
import { mergePageHistoryEntries } from "./page-history-view-model";
import { HistoryPanel as HistoryPanelView, type HistoryPanelProps } from "./history-panel";
const HistoryPanel = (props: Omit<HistoryPanelProps, "fileAuthority">) => (
  <HistoryPanelView
    {...props}
    fileAuthority={{
      libraryId: "library:one",
      storeEpoch: "epoch:one",
      contentAccessContext: { kind: "project", projectId: props.projectId },
    }}
  />
);

type HistoryPanelApiOperation =
  | "listPageHistory"
  | "getDocumentVersion"
  | "getOwnedDocumentDescriptor"
  | "restoreDocumentVersion";

const callHistoryPanelApi = async (
  operation: HistoryPanelApiOperation,
  ...args: unknown[]
): Promise<unknown> => {
  const handler = (
    globalThis as {
      __historyPanelApi?: (
        operation: HistoryPanelApiOperation,
        ...args: unknown[]
      ) => Promise<unknown> | unknown;
    }
  ).__historyPanelApi;
  if (!handler) throw new Error(`Unhandled HistoryPanel API: ${operation}`);
  return await handler(operation, ...args);
};

vi.mock("./history-panel-deps", () => ({
  listPageHistory: (...args: unknown[]) => callHistoryPanelApi("listPageHistory", ...args),
  getDocumentVersion: (...args: unknown[]) => callHistoryPanelApi("getDocumentVersion", ...args),
  getOwnedDocumentDescriptor: (...args: unknown[]) =>
    callHistoryPanelApi("getOwnedDocumentDescriptor", ...args),
  restoreDocumentVersion: (...args: unknown[]) =>
    callHistoryPanelApi("restoreDocumentVersion", ...args),
}));

afterEach(() => {
  delete (globalThis as { __historyPanelApi?: unknown }).__historyPanelApi;
});

const selectCheckpoint = async (view: ReturnType<typeof render>) => {
  await waitFor(() => {
    if (!view.queryByRole("button", { name: /Manual checkpoint/ })) {
      throw new Error("Checkpoint revision did not render");
    }
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /Manual checkpoint/ }));
    await Promise.resolve();
  });
  await waitFor(() => {
    if (!textContent(document.body).includes("Checkpoint body")) {
      throw new Error("Checkpoint preview did not load");
    }
  });
};

describe("canonical Page history panel", () => {
  test("previews and forward-restores a Document checkpoint", async () => {
    const checkpoint = makeCheckpointEntry();
    const calls: HistoryPanelApiOperation[] = [];
    const restoreRequests: Record<string, unknown>[] = [];
    let mutationCount = 0;

    setHistoryPanelApi((operation, ...args) => {
      calls.push(operation);
      if (operation === "listPageHistory") {
        return { ok: true, value: makePage([checkpoint]) };
      }
      if (operation === "getDocumentVersion") {
        return { ok: true, value: makeVersionDetail() };
      }
      if (operation === "getOwnedDocumentDescriptor") {
        return makeDescriptor();
      }
      restoreRequests.push(args[2] as Record<string, unknown>);
      if (restoreRequests.length === 1) {
        throw new Error("ACK lost after commit");
      }
      return { ok: true, value: { mutationId: "restore-committed" } };
    });

    const view = render(
      <HistoryPanel
        projectId="project-1"
        pageId="card-1"
        pageTitle="Current title"
        pageNfm="Current body"
        projectWorkspacePath="/workspace/project-1"
        open
        onClose={() => undefined}
        onPageMutated={() => {
          mutationCount += 1;
        }}
      />,
    );

    await waitFor(() => {
      if (!textContent(document.body).includes("Current body")) {
        throw new Error("Current Page content did not render");
      }
    });
    expect(calls.includes("listPageHistory")).toBe(true);
    expect(calls.includes("getDocumentVersion")).toBe(false);

    await selectCheckpoint(view);
    expect(calls.includes("getDocumentVersion")).toBe(true);
    expect(textContent(document.body).includes("forward change")).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore title & body" }));
      await Promise.resolve();
    });
    expect(textContent(document.body).includes("new forward change")).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (mutationCount !== 1) throw new Error("Restore did not commit");
    });

    expect(restoreRequests.length).toBe(2);
    expect(restoreRequests[0]?.mutationId).toBe(restoreRequests[1]?.mutationId);
    expect(restoreRequests[0]?.versionId).toBe("version-1");
    expect(restoreRequests[0]?.expectedHeadSeq).toBe(14);
    expect((restoreRequests[0]?.actor as Record<string, unknown> | undefined)?.kind).toBe(
      "renderer_history_restore",
    );
  });

  test("submits a successful restore exactly once", async () => {
    const checkpoint = makeCheckpointEntry();
    let restoreCount = 0;

    setHistoryPanelApi((operation) => {
      if (operation === "listPageHistory") {
        return { ok: true, value: makePage([checkpoint]) };
      }
      if (operation === "getDocumentVersion") {
        return { ok: true, value: makeVersionDetail() };
      }
      if (operation === "getOwnedDocumentDescriptor") {
        return makeDescriptor();
      }
      restoreCount += 1;
      return { ok: true, value: { mutationId: "restore-committed" } };
    });

    const view = render(
      <HistoryPanel projectId="project-1" pageId="card-1" open onClose={() => undefined} />,
    );
    await selectCheckpoint(view);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore title & body" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!view.queryByRole("button", { name: "Confirm restore" })) {
        throw new Error("Restore confirmation did not open");
      }
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (restoreCount !== 1) throw new Error("Restore did not settle");
    });

    expect(restoreCount).toBe(1);
  });

  test("retains an ambiguously delivered or still-retryable restore request", async () => {
    const checkpoint = makeCheckpointEntry();
    const restoreMutationIds: string[] = [];
    let descriptorCount = 0;

    setHistoryPanelApi((operation, ...args) => {
      if (operation === "listPageHistory") {
        return { ok: true, value: makePage([checkpoint]) };
      }
      if (operation === "getDocumentVersion") {
        return { ok: true, value: makeVersionDetail() };
      }
      if (operation === "getOwnedDocumentDescriptor") {
        descriptorCount += 1;
        return makeDescriptor();
      }
      const request = args[2] as Record<string, unknown>;
      restoreMutationIds.push(String(request.mutationId));
      if (restoreMutationIds.length === 1) {
        throw new Error("delivery outcome unknown");
      }
      if (restoreMutationIds.length === 2) {
        return {
          ok: false,
          error: {
            code: "document_busy",
            message: "exact restore retry is still pending",
            retryable: true,
          },
        };
      }
      return { ok: true, value: { mutationId: request.mutationId } };
    });

    const view = render(
      <HistoryPanel projectId="project-1" pageId="card-1" open onClose={() => undefined} />,
    );
    await selectCheckpoint(view);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore title & body" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!view.queryByRole("button", { name: "Confirm restore" })) {
        throw new Error("Restore confirmation did not open");
      }
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!textContent(document.body).includes("exact restore retry is still pending")) {
        throw new Error("Retryable delivery was not surfaced");
      }
    });
    expect(restoreMutationIds.length).toBe(2);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (restoreMutationIds.length !== 3) {
        throw new Error("Pending restore was not retried");
      }
    });

    expect(descriptorCount).toBe(1);
    expect(restoreMutationIds[0]).toBe(restoreMutationIds[1]);
    expect(restoreMutationIds[1]).toBe(restoreMutationIds[2]);
  });

  test("clears a terminally rejected restore request", async () => {
    const checkpoint = makeCheckpointEntry();
    const restoreMutationIds: string[] = [];
    let descriptorCount = 0;

    setHistoryPanelApi((operation, ...args) => {
      if (operation === "listPageHistory") {
        return { ok: true, value: makePage([checkpoint]) };
      }
      if (operation === "getDocumentVersion") {
        return { ok: true, value: makeVersionDetail() };
      }
      if (operation === "getOwnedDocumentDescriptor") {
        descriptorCount += 1;
        return makeDescriptor();
      }
      const request = args[2] as Record<string, unknown>;
      restoreMutationIds.push(String(request.mutationId));
      if (restoreMutationIds.length === 1) {
        return {
          ok: false,
          error: {
            code: "document_conflict",
            message: "checkpoint head is stale",
            retryable: false,
          },
        };
      }
      return { ok: true, value: { mutationId: request.mutationId } };
    });

    const view = render(
      <HistoryPanel projectId="project-1" pageId="card-1" open onClose={() => undefined} />,
    );
    await selectCheckpoint(view);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore title & body" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!view.queryByRole("button", { name: "Confirm restore" })) {
        throw new Error("Restore confirmation did not open");
      }
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!textContent(document.body).includes("checkpoint head is stale")) {
        throw new Error("Terminal rejection was not surfaced");
      }
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (restoreMutationIds.length !== 2) {
        throw new Error("Fresh restore was not submitted");
      }
    });

    expect(descriptorCount).toBe(2);
    expect(restoreMutationIds[0] === restoreMutationIds[1]).toBe(false);
  });

  test("paginates merged evidence and never offers an inverse for mutations", async () => {
    const mutation = makeMutationEntry();
    const relocation = makeRelocationEntry();
    let listCount = 0;
    let previewCount = 0;

    setHistoryPanelApi((operation, ...args) => {
      if (operation === "getDocumentVersion") {
        previewCount += 1;
        throw new Error("Mutation evidence must not request a checkpoint preview");
      }
      if (operation !== "listPageHistory") {
        throw new Error(`Unexpected operation: ${operation}`);
      }
      listCount += 1;
      const request = args[0] as { before?: unknown };
      if (!request.before) {
        return {
          ok: true,
          value: makePage([mutation], {
            occurredAt: mutation.occurredAt,
            source: "change_log",
            changeSeq: mutation.changeSeq,
          }),
        };
      }
      return { ok: true, value: makePage([relocation]) };
    });

    const view = render(
      <HistoryPanel projectId="project-1" pageId="card-1" open onClose={() => undefined} />,
    );
    const activityButton = await view.findByRole("button", { name: "Activity" });
    await act(async () => {
      fireEvent.click(activityButton);
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!textContent(document.body).includes("Changed Page properties")) {
        throw new Error("Mutation evidence did not render");
      }
    });

    expect(textContent(document.body).includes("no inverse operation")).toBe(true);
    expect(view.queryByRole("button", { name: "Restore title & body" }) === null).toBe(true);
    expect(previewCount).toBe(0);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load earlier" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!textContent(document.body).includes("Moved blocks")) {
        throw new Error("Earlier relocation evidence did not render");
      }
    });
    expect(listCount).toBe(2);
  });

  test("deduplicates an inclusive pagination boundary", () => {
    const mutation = makeMutationEntry();
    const relocation = makeRelocationEntry();

    const merged = mergePageHistoryEntries([mutation], [mutation, relocation]);

    expect(merged.length).toBe(2);
    expect(merged[0]?.id).toBe(mutation.id);
    expect(merged[1]?.id).toBe(relocation.id);
  });
});

function setHistoryPanelApi(
  handler: (operation: HistoryPanelApiOperation, ...args: unknown[]) => Promise<unknown> | unknown,
): void {
  (globalThis as { __historyPanelApi?: typeof handler }).__historyPanelApi = handler;
}

const HASH = "a".repeat(64);

function makeCheckpointEntry(): Extract<PageHistoryEntry, { kind: "document_version" }> {
  return {
    id: "document-version:version-1",
    kind: "document_version",
    libraryId: "library-1",
    pageId: "card-1",
    documentId: "document-1",
    occurredAt: "2026-07-12T08:00:00.000Z",
    display: {
      category: "checkpoint",
      title: "Manual checkpoint",
      detail: "Saved before restructuring the Page",
      actorLabel: "Local window",
    },
    evidence: { status: "verified" },
    recovery: {
      kind: "restore_document_version",
      documentId: "document-1",
      versionId: "version-1",
    },
    versionMetadata: {
      versionId: "version-1",
      generation: 1,
      baseHeadSeq: 8,
      schemaKey: "nodex.page",
      schemaVersion: 1,
      cause: "manual",
      label: "Before restructure",
      revisionKind: "manual",
      sourceMutationId: null,
      sourceChangeSeq: null,
      pinned: true,
      checkpointHash: HASH,
      byteLength: 1_024,
    },
  };
}

function makeMutationEntry(): Extract<PageHistoryEntry, { kind: "block_mutation" }> {
  return {
    id: "change-log:21",
    kind: "block_mutation",
    libraryId: "library-1",
    pageId: "card-1",
    documentId: "document-1",
    occurredAt: "2026-07-12T07:00:00.000Z",
    display: {
      category: "property",
      title: "Changed Page properties",
      detail: "Updated two property values",
      actorLabel: "Local window",
    },
    evidence: { status: "verified" },
    recovery: { kind: "unavailable", reason: "no_inverse_contract" },
    changeSeq: 21,
    mutationId: "mutation-21",
    mutationKind: "database_mutation",
    affectedBlockCount: 1,
    fieldIntentCount: 2,
  };
}

function makeRelocationEntry(): Extract<PageHistoryEntry, { kind: "block_relocation" }> {
  return {
    id: "change-log:20",
    kind: "block_relocation",
    libraryId: "library-1",
    pageId: "card-1",
    documentId: "document-1",
    occurredAt: "2026-07-12T06:00:00.000Z",
    display: {
      category: "location",
      title: "Moved blocks",
      detail: "Moved two blocks into this Page",
      actorLabel: null,
    },
    evidence: { status: "verified" },
    recovery: { kind: "unavailable", reason: "no_inverse_contract" },
    changeSeq: 20,
    relocationId: "relocation-20",
    direction: "into_page",
    movedBlockCount: 2,
  };
}

function makePage(
  entries: readonly PageHistoryEntry[],
  nextCursor: PageHistoryPage["nextCursor"] = null,
): PageHistoryPage {
  return {
    libraryId: "library-1",
    pageId: "card-1",
    documentId: "document-1",
    entries,
    nextCursor,
  };
}

function makeVersionDetail(): DocumentVersionDetail {
  return {
    summary: {
      versionId: "version-1",
      documentId: "document-1",
      projectId: "project-1",
      generation: 1,
      baseHeadSeq: 8,
      schemaKey: "nodex.page",
      schemaVersion: 1,
      cause: "manual",
      label: "Before restructure",
      actor: { kind: "renderer" },
      revisionKind: "manual",
      sourceMutationId: null,
      sourceChangeSeq: null,
      pinned: true,
      checkpointHash: HASH,
      fileSnapshotStatus: "exact",
      checkpointMetadata: {
        format: "yjs_update_v1",
        stateVectorHash: HASH,
      },
      materializationHash: HASH,
      byteLength: 1_024,
      materializationKind: "page",
      title: "Checkpoint title",
      preview: "Checkpoint body",
      blockCount: 1,
      createdAt: "2026-07-12T08:00:00.000Z",
    },
    materialization: {
      kind: "page",
      schemaVersion: 1,
      title: "Checkpoint title",
      richTitle: [{ type: "text", text: "Checkpoint title", styles: {} }],
      blockTree: [],
      nfm: "Checkpoint body",
      plainText: "Checkpoint body",
      preview: "Checkpoint body",
      references: [],
      assetRefs: [],
    },
  };
}

function makeDescriptor(): OwnedDocumentDescriptor {
  return {
    libraryId: "library-1",
    accessContext: { kind: "project", projectId: "project-1" },
    ownerBlockId: "card-1",
    ownerType: "page",
    ownerLifecycle: "active",
    documentId: "document-1",
    authorization: null,
    storeEpoch: "epoch-1",
    generation: 1,
    headSeq: 14,
    schemaKey: "nodex.page",
    schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
    readiness: "ready",
    sync: { kind: "yjs", stateVector: new Uint8Array() },
  };
}
