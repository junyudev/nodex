import { locks } from "node:worker_threads";
import { IndexedDbDocumentLocalCheckpointStore } from "@/lib/document-local-checkpoint";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import { openNodexMenu, settleAsyncRender } from "@/test/dom";
import { renderWithMaitai } from "@/test/thread-maitai";
import { DocumentRecovery, type DocumentRecoveryPort } from "@/lib/document-recovery";
import type { RecoveryDraftInspection } from "../../../shared/block-documents/document-recovery";
import type { MarkdownBlock, MarkdownInline } from "../../../shared/nodex-markdown";
import { RecoveryReview } from "./recovery-review";

const blockText = (block: MarkdownBlock): string =>
  (block.content as readonly MarkdownInline[]).map((inline) => inline.text ?? "").join("");

vi.mock("./recovery-preview", () => ({
  RecoveryDocumentPreview: ({ content }: { content: string | readonly MarkdownBlock[] }) => (
    <p>{typeof content === "string" ? content : content.map(blockText).join(" | ")}</p>
  ),
  RecoveryCanvasPreview: () => <p>Canvas</p>,
}));

const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  writeText.mockClear();
  vi.stubGlobal(
    "navigator",
    Object.create(navigator, { locks: { value: locks }, clipboard: { value: { writeText } } }),
  );
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const scope = { libraryId: "library:recovery", routingContext: { kind: "library" as const } };
const createInspection = (
  overrides: Partial<RecoveryDraftInspection> & { readonly id?: string } = {},
): RecoveryDraftInspection => {
  const { id = "draft:retained", ...rest } = overrides;
  return {
    summary: {
      draft_id: id,
      document_id: "document:source",
      source_title: id,
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
    ...rest,
  };
};

interface DraftFixture {
  inspection: RecoveryDraftInspection;
  readonly current: string;
  readonly merged: string;
}

/** A port backed by mutable drafts, so resolving behaves like Core rather than a canned reply. */
const createPort = (drafts: DraftFixture[]) => {
  const fixture = (id: string) => drafts.find((draft) => draft.inspection.summary.draft_id === id)!;
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
    export: vi.fn(async () => ({ ok: true as const, status: "saved" as const })),
    read: vi.fn<DocumentRecoveryPort["read"]>(async (_scope, read) => ({
      ok: true,
      storeEpoch: "epoch:one",
      value:
        read.kind === "list"
          ? {
              kind: "list",
              page: {
                drafts: drafts
                  .map((draft) => draft.inspection.summary)
                  .filter((summary) => read.include_resolved || !summary.resolution),
                pending_count: drafts.filter((draft) => !draft.inspection.summary.resolution)
                  .length,
              },
            }
          : read.kind === "inspect"
            ? { kind: "inspect", inspection: fixture(read.draft_id).inspection }
            : {
                kind: "preview",
                result: {
                  kind: "complete",
                  preview: {
                    kind: "document",
                    title: "Title",
                    rich_title: [],
                    markdown:
                      read.request.view === "current"
                        ? fixture(read.request.draft_id).current
                        : fixture(read.request.draft_id).merged,
                    files: {},
                  },
                },
              },
    })),
    apply: vi.fn(async (command) => {
      if (command.kind !== "resolve") throw new Error("No local drafts in this fixture");
      const draft = fixture(command.resolve.draft_id);
      const choice = command.resolve.choice.kind;
      if (choice === "reconcile") return draft.inspection.summary;
      const resolution =
        choice === "discard"
          ? "discarded"
          : choice === "reopen"
            ? null
            : choice === "copy"
              ? "copied"
              : "restored";
      draft.inspection = {
        ...draft.inspection,
        summary: {
          ...draft.inspection.summary,
          revision: draft.inspection.summary.revision + 1,
          resolution,
        },
        can_restore: !resolution,
        can_copy: !resolution,
      };
      return draft.inspection.summary;
    }),
  };
  return port;
};

const renderReview = async (
  port: DocumentRecoveryPort,
  documentId: string | null = "document:source",
  props: { readonly initialDraftId?: string; readonly initialSourceKey?: string } = {},
) => {
  const module = new DocumentRecovery(scope, documentId, port);
  vi.spyOn(module, "connect").mockReturnValue(() => {});
  await module.refresh();
  const close = vi.fn();
  const inclusion = vi.spyOn(module, "setIncludeResolved");
  const view = renderWithMaitai(<RecoveryReview module={module} onClose={close} {...props} />);
  // Opening the review rereads the list; let that publish before the test acts on it.
  await act(async () => {
    await Promise.all(inclusion.mock.results.map((result) => result.value as Promise<void>));
  });
  const click = async (name: string) => {
    const button = await view.findByRole("button", { name }, { timeout: 5_000 });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false), {
      timeout: 5_000,
    });
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
  };
  // The trigger's own press ingress, then the frame in which closing the menu returns focus to it
  // and its tooltip positions itself, all inside act.
  const clickMenuItem = async (name: string) => {
    const trigger = await view.findByRole("button", { name: "More actions" }, { timeout: 5_000 });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false), {
      timeout: 5_000,
    });
    await openNodexMenu(trigger);
    const item = await view.findByRole("menuitem", { name });
    await act(async () => {
      fireEvent.click(item);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    await settleAsyncRender();
  };
  return { module, close, view, click, clickMenuItem };
};

test("the review answers what restoring would change and resolves with one decision", async () => {
  const port = createPort([
    {
      inspection: createInspection(),
      current: "Keep\n\nOnly in the Page now",
      merged: "Keep\n\nOnly in the Page now\n\nWritten while offline",
    },
  ]);
  const { module, close, view, click } = await renderReview(port);
  await view.findByText("Restoring adds 1 block.");
  expect(view.getByRole("region", { name: "Added" }).textContent).toBe("Written while offline");
  // Closing keeps the draft for later; nothing else asks the person to postpone.
  expect(view.queryByRole("button", { name: "Later" })).toBeNull();
  expect(module.getSnapshot().pendingCount).toBe(1);
  await click("Restore edits");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(0));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

test("discarding needs no confirmation because it can be undone", async () => {
  const port = createPort([
    { inspection: createInspection(), current: "Keep", merged: "Keep\n\nNew" },
  ]);
  const info = vi.spyOn(toast, "info");
  const { module, close, click } = await renderReview(port);
  await click("Discard");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(0));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(info).toHaveBeenCalledOnce();
  await act(async () => {
    info.mock.calls[0]![1]!.action!.onClick();
    await Promise.resolve();
  });
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(1));
  const choices = vi
    .mocked(port.apply)
    .mock.calls.flatMap(([command]) =>
      command.kind === "resolve" ? [command.resolve.choice.kind] : [],
    );
  expect(choices.filter((choice) => choice !== "reconcile")).toEqual(["discard", "reopen"]);
});

test("discarding one of several offers Undo inside the review, where it can be reached", async () => {
  const port = createPort(
    ["First", "Second"].map((id) => ({
      inspection: createInspection({ id }),
      current: "Keep",
      merged: `Keep\n\n${id} edit`,
    })),
  );
  const info = vi.spyOn(toast, "info");
  const { module, close, view, click } = await renderReview(port, null, {
    initialDraftId: "First",
  });
  await view.findByText("First edit");
  await click("Discard");
  await view.findByText("Second edit");
  // A toast outside the open modal is inert, so it must not be the only way back.
  expect(info).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await view.findByRole("status");
  await click("Undo");
  await view.findByText("First edit");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(2));
});

test("a draft with nothing new recommends discarding it instead of a dead end", async () => {
  const port = createPort([
    {
      inspection: createInspection({ can_restore: false, can_copy: false }),
      current: "Same\n\nWords",
      merged: "Same\n\nWords",
    },
  ]);
  const { view, module, click } = await renderReview(port);
  await view.findByText("Nothing new. Everything in these edits is already in the Page.");
  expect(view.queryByRole("button", { name: "Restore edits" })).toBeNull();
  expect(view.queryByRole("button", { name: "Copy new content" })).toBeNull();
  expect(view.getAllByRole("button", { name: "Discard" })).toHaveLength(1);
  await click("Discard");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(0));
});

test("content Core refuses to merge can be copied without what the Page already has", async () => {
  const explanation = "They use nested Pages or files that weren’t captured with them.";
  const port = createPort([
    {
      inspection: createInspection({ can_restore: false, can_copy: false, explanation }),
      current: "Keep",
      merged: "Keep\n\nOnly in the edits",
    },
  ]);
  const { view, click, clickMenuItem } = await renderReview(port);
  await view.findByText("1 block isn’t in the Page yet.");
  view.getByText(explanation);
  await click("Copy new content");
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Only in the edits"));
  await clickMenuItem("Copy as Markdown");
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Keep\n\nOnly in the edits"));
  await clickMenuItem("Export backup");
  await waitFor(() =>
    expect(port.export).toHaveBeenCalledWith({
      ...scope,
      kind: "received",
      draftId: "draft:retained",
    }),
  );
});

test("resolving one of several drafts moves on to the next, then closes", async () => {
  const port = createPort(
    ["First", "Second"].map((id) => ({
      inspection: createInspection({ id }),
      current: "Keep",
      merged: `Keep\n\n${id} edit`,
    })),
  );
  const { module, close, view, click } = await renderReview(port, null, {
    initialDraftId: "First",
  });
  const rail = await view.findByRole("navigation", { name: "Unsaved edits" });
  expect(rail.querySelector("[aria-current]")?.textContent).toContain("First");
  await view.findByText("First edit");
  await click("Restore edits");
  await waitFor(() => expect(module.getSnapshot().pendingCount).toBe(1));
  await view.findByText("Second edit");
  expect(close).not.toHaveBeenCalled();
  await click("Restore edits");
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

test("an issue opens its exact draft and retargeting the review resets the previous selection", async () => {
  const port = createPort(
    ["First", "Second"].map((id) => ({
      inspection: createInspection({ id }),
      current: "Keep",
      merged: `Keep\n\n${id} edit`,
    })),
  );
  const { module, close, view } = await renderReview(port, "document:source", {
    initialDraftId: "Second",
  });
  await view.findByText("Second edit");
  view.rerender(<RecoveryReview module={module} initialDraftId="First" onClose={close} />);
  await view.findByText("First edit");
  expect(module.getSnapshot().pendingCount).toBe(2);
  expect(port.apply).not.toHaveBeenCalled();
});

test("a closed document's edits on this device stay exportable while Core is offline", async () => {
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
  const { module, view, clickMenuItem } = await renderReview(port, null);
  const source = module.getSnapshot().staged[0]!;
  const exported = vi.spyOn(module, "exportLocal").mockResolvedValue();
  await act(async () => {
    view.rerender(
      <RecoveryReview module={module} initialSourceKey={source.sourceKey} onClose={() => {}} />,
    );
    await module.refresh();
  });
  await view.findByRole("button", { name: "Try again" });
  await clickMenuItem("Export backup");
  await waitFor(() => expect(exported).toHaveBeenCalledWith(source.sourceKey));
  expect(port.apply).not.toHaveBeenCalled();
  expect(await store.staging.countSummaries(scope, null)).toBe(1);
});

test("a preview failure keeps the decision Core still allows and the backup", async () => {
  const inspection = createInspection({ can_restore: false, can_copy: false });
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
    apply: vi.fn(async () => inspection.summary),
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
  const { module, view, click } = await renderReview(port, null);
  await view.findByText("Preview cannot be decoded");
  await click("Export backup");
  await waitFor(() =>
    expect(port.export).toHaveBeenCalledWith({
      ...scope,
      kind: "received",
      draftId: inspection.summary.draft_id,
    }),
  );
  expect(module.getSnapshot().pendingCount).toBe(1);
});

test("edits on this device can be kept, or permanently removed after confirming", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(indexedDB);
  await store.quarantine(
    {
      documentId: "document:offline",
      storeEpoch: "epoch:old",
      generation: 1,
      headSeq: 1,
      state: new Uint8Array([0, 0]),
      updatedAt: "2026-09-04T00:00:00.000Z",
      recoveryId: "draft:offline",
      schema: { ownerType: "page", schemaKey: "nodex.page", schemaVersion: 1 },
      error: { code: "unknown", message: "uncertain", retryable: false, resetRequired: false },
    },
    { maxStateBytes: 200_000 },
  );
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
    read: async () => {
      throw new Error("Core offline");
    },
    apply: vi.fn(async () => {
      throw new Error("No content mutations allowed");
    }),
    export: async () => ({ ok: true, status: "saved" }),
  };
  const { module, close, view, click } = await renderReview(port, null);
  await click("Remove");
  expect(module.getSnapshot().stagedCount).toBe(1);
  await click("Keep");
  expect(module.getSnapshot().stagedCount).toBe(1);
  await click("Remove");
  await click("Remove permanently");
  await waitFor(() => expect(module.getSnapshot().stagedCount).toBe(0));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  // Removing publishes the review's last updates while the store finishes; let both land in act.
  await settleAsyncRender();
  expect(await act(async () => store.nextRecovery("document:offline"))).toBeNull();
  expect(port.apply).not.toHaveBeenCalled();
  view.unmount();
});
