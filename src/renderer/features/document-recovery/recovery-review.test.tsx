import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { renderWithMaitai } from "@/test/dom";
import { DocumentRecovery, type DocumentRecoveryPort } from "@/lib/document-recovery";
import type { RecoveryDraftInspection } from "../../../shared/block-documents/document-recovery";
import { RecoveryReview } from "./recovery-review";

vi.mock("./recovery-preview", () => ({
  RecoveryPreview: ({ value }: { value?: { title?: string } }) => (
    <article aria-label="Recovery preview">{value?.title}</article>
  ),
}));

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
  capture: {
    draft_id: "draft:retained",
    document_id: "document:source",
    source_store_epoch: "epoch:one",
    generation: 1,
    base_head_seq: 1,
    created_at: "2026-09-04T00:00:00.000Z",
    schema_key: "page",
    schema_version: 1,
    content: { kind: "yjs", state: [], unintegrated_updates: [] },
    source: {},
  },
  current_generation: 1,
  current_head_seq: 1,
  already_saved: false,
  can_restore: true,
  can_copy: true,
  retained: { kind: "document", title: "Retained edits", rich_title: [], nfm: "" },
  restored: { kind: "document", title: "Merged edits", rich_title: [], nfm: "" },
  current: { kind: "document", title: "Current content", rich_title: [], nfm: "" },
});

test("review keeps export and Later separate from persisted discard, undo and restore", async () => {
  let inspection = createInspection();
  const port: DocumentRecoveryPort = {
    subscribe: () => () => {},
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
          : { kind: "inspect", inspection },
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
    await act(async () => {
      fireEvent.click(await view.findByRole("button", { name }));
      await Promise.resolve();
    });
  };
  expect((await view.findByRole("article", { name: "Recovery preview" })).textContent).toBe(
    "Merged edits",
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
