import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai } from "@/test/thread-maitai";
import { DocumentRecovery, type DocumentRecoveryPort } from "@/lib/document-recovery";
import type { RecoveryDraftInspection } from "../../../shared/block-documents/document-recovery";
import { RecoveryReview } from "./recovery-review";

vi.mock("./recovery-preview", () => ({
  RecoveryPreview: ({ value }: { value?: { title?: string } }) => (
    <article aria-label="Recovery preview">{value?.title}</article>
  ),
}));

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());

const scope = { libraryId: "library:recovery", accessContext: { kind: "library" as const } };
const createInspection = (): RecoveryDraftInspection => ({
  summary: {
    draft_id: "draft:retained",
    document_id: "document:source",
    source_title: "Research",
    revision: 1,
    created_at: "2026-09-04T00:00:00.000Z",
    received_at: "2026-09-04T00:00:00.000Z",
    payload_hash: "hash",
    byte_length: 200,
  },
  source_store_epoch: "epoch:one",
  source_generation: 1,
  current_generation: 1,
  current_head_seq: 1,
  already_saved: false,
  can_restore: true,
  can_copy: true,
  retained: true,
  restored: true,
  current: true,
});

test("review keeps export and Later separate from persisted discard, undo and restore", async () => {
  let inspection = createInspection();
  let currentTitle = "Current content";
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
    export: async () => ({ ok: true as const, status: "saved" as const }),
    read: vi.fn<DocumentRecoveryPort["read"]>(async (_scope, read) => ({
      ok: true,
      storeEpoch: "epoch:one",
      value:
        read.kind === "list"
          ? {
              kind: "list",
              page: {
                drafts: [inspection.summary],
                pending_count: inspection.summary.resolution ? 0 : 1,
              },
            }
          : read.kind === "inspect"
            ? { kind: "inspect", inspection }
            : {
                kind: "preview",
                result: {
                  kind: "complete",
                  preview: {
                    kind: "document",
                    title: read.request.view === "current" ? currentTitle : "Merged edits",
                    rich_title: [],
                    nfm: "",
                    files: {},
                  },
                },
              },
    })),
    apply: vi.fn(async (command) => {
      if (command.kind !== "resolve") throw new Error("No local drafts in this fixture");
      const choice = command.resolve.choice.kind;
      if (choice === "reconcile") return inspection.summary;
      const resolution =
        choice === "discard" ? "discarded" : choice === "reopen" ? null : "restored";
      inspection = {
        ...inspection,
        summary: { ...inspection.summary, revision: inspection.summary.revision + 1, resolution },
        can_restore: !resolution,
        can_copy: !resolution,
      };
      return inspection.summary;
    }),
  };
  const module = new DocumentRecovery(scope, "document:source", port);
  vi.spyOn(module, "connect").mockReturnValue(() => {});
  const exportDraft = vi.spyOn(module, "export").mockResolvedValue();
  await module.refresh();
  const close = vi.fn();
  const view = renderWithMaitai(<RecoveryReview module={module} onClose={close} />);
  const click = async (name: string) => {
    await view.findByRole("button", { name });
    await waitFor(() =>
      expect((view.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name }));
      await Promise.resolve();
    });
  };
  await waitFor(() =>
    expect(view.getByRole("article", { name: "Recovery preview" }).textContent).toBe(
      "Merged edits",
    ),
  );
  await click("Current content");
  currentTitle = "New current content";
  await act(async () => {
    await module.refresh();
  });
  await waitFor(() =>
    expect(view.getByRole("article", { name: "Recovery preview" }).textContent).toBe(
      "New current content",
    ),
  );
  await click("Export");
  expect(exportDraft).toHaveBeenCalledWith("draft:retained");
  expect(module.getSnapshot().pendingCount).toBe(1);
  await click("Later");
  expect(close).toHaveBeenCalledOnce();
  expect(module.getSnapshot().pendingCount).toBe(1);
  await click("Discard draft");
  expect(module.getSnapshot().pendingCount).toBe(1);
  await click("Discard");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(0));
  await click("Undo discard");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(1));
  await click("Restore edits");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(0));
  expect((await view.findByRole("status")).textContent).toBe("Edits restored and saved.");
  const choices = vi
    .mocked(port.apply)
    .mock.calls.flatMap(([command]) =>
      command.kind === "resolve" ? [command.resolve.choice.kind] : [],
    );
  expect(choices.filter((choice) => choice !== "reconcile")).toEqual([
    "discard",
    "reopen",
    "restore",
  ]);
});

test("an issue opens its exact draft and retargeting the review resets the previous selection", async () => {
  const drafts = ["First", "Second"].map((title) => {
    const base = createInspection();
    return {
      ...base,
      summary: { ...base.summary, draft_id: title, source_title: title },
      restored: true,
    };
  });
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
    export: async () => ({ ok: true as const, status: "saved" as const }),
    read: async (_scope, read) => ({
      ok: true,
      storeEpoch: "epoch:one",
      value:
        read.kind === "list"
          ? {
              kind: "list",
              page: { drafts: drafts.map((draft) => draft.summary), pending_count: 2 },
            }
          : read.kind === "inspect"
            ? {
                kind: "inspect",
                inspection: drafts.find((draft) => draft.summary.draft_id === read.draft_id)!,
              }
            : {
                kind: "preview",
                result: {
                  kind: "complete",
                  preview: {
                    kind: "document",
                    title: read.request.draft_id,
                    rich_title: [],
                    nfm: "",
                    files: {},
                  },
                },
              },
    }),
    apply: async (command) => {
      if (command.kind !== "resolve" || command.resolve.choice.kind !== "reconcile")
        throw new Error("Unexpected content mutation");
      return drafts.find((draft) => draft.summary.draft_id === command.resolve.draft_id)!.summary;
    },
  };
  const module = new DocumentRecovery(scope, "document:source", port);
  vi.spyOn(module, "connect").mockReturnValue(() => {});
  await module.refresh();
  const close = vi.fn();
  const view = renderWithMaitai(
    <RecoveryReview module={module} initialDraftId="Second" onClose={close} />,
  );
  await waitFor(() =>
    expect(view.getByRole("article", { name: "Recovery preview" }).textContent).toBe("Second"),
  );
  view.rerender(<RecoveryReview module={module} initialDraftId="First" onClose={close} />);
  await waitFor(() =>
    expect(view.getByRole("article", { name: "Recovery preview" }).textContent).toBe("First"),
  );
  expect(module.getSnapshot().pendingCount).toBe(2);
});

test("a closed document's local package remains selectable and exportable while Core is offline", async () => {
  const { IndexedDbDocumentLocalCheckpointStore } = await import("@/lib/document-local-checkpoint");
  const store = new IndexedDbDocumentLocalCheckpointStore(indexedDB, scope);
  await store.quarantine(
    {
      documentId: "closed:document",
      storeEpoch: "old:epoch",
      generation: 1,
      headSeq: 0,
      recoveryId: "local:offline",
      state: new Uint8Array([255, 128]),
      updatedAt: "2026-09-12T00:00:00Z",
      schema: { ownerType: "page", schemaKey: "nodex.page", schemaVersion: 1 },
      error: { code: "unknown", message: "not received", retryable: false, resetRequired: false },
    },
    { maxStateBytes: 1000 },
  );
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
    read: async () => {
      throw new Error("Core is offline");
    },
    apply: vi.fn(),
    export: vi.fn(),
  };
  const module = new DocumentRecovery(scope, null, port);
  vi.spyOn(module, "connect").mockReturnValue(() => {});
  const exported = vi.spyOn(module, "exportLocal").mockResolvedValue();
  await module.refresh();
  const source = module.getSnapshot().staged[0]!;
  const view = renderWithMaitai(
    <RecoveryReview module={module} initialSourceKey={source.sourceKey} onClose={() => {}} />,
  );
  expect((await view.findByRole("status")).textContent).toBe("Retained on this device");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Export" }));
    await Promise.resolve();
  });
  expect(exported).toHaveBeenCalledWith(source.sourceKey);
  expect(port.apply).not.toHaveBeenCalled();
  expect(await store.staging.countSummaries(scope, null)).toBe(1);
});

test("preview failure leaves the received package's export action available", async () => {
  const inspection = createInspection();
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
    apply: vi.fn(),
    export: vi.fn(async () => ({ ok: true as const, status: "saved" as const })),
    read: async (_scope, read) => {
      if (read.kind === "preview") throw new Error("Preview cannot be decoded");
      return {
        ok: true,
        storeEpoch: "epoch:one",
        value:
          read.kind === "list"
            ? { kind: "list", page: { drafts: [inspection.summary], pending_count: 1 } }
            : { kind: "inspect", inspection },
      };
    },
  };
  const module = new DocumentRecovery(scope, null, port);
  vi.spyOn(module, "connect").mockReturnValue(() => {});
  await module.refresh();
  const view = renderWithMaitai(<RecoveryReview module={module} onClose={() => {}} />);
  await view.findByText("Preview cannot be decoded");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Export" }));
    await Promise.resolve();
  });
  expect(port.export).toHaveBeenCalledWith({
    ...scope,
    kind: "received",
    draftId: inspection.summary.draft_id,
  });
  expect(module.getSnapshot().pendingCount).toBe(1);
  expect(port.apply).not.toHaveBeenCalled();
});
