import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import type { FileReadAuthority } from "@/lib/library-file-resources";
import { NodexModalHost } from "@/lib/modal-registry";
import { ReadonlyMarkdownBlockNotePreview } from "./readonly-nfm-blocknote-preview";

const reads = vi.hoisted(() => ({ metadata: vi.fn(), bytes: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/library-file-resources", async (original) => ({
  ...(await original<typeof import("@/lib/library-file-resources")>()),
  readFilePresentation: reads.metadata,
  readAuthorizedFile: reads.bytes,
  saveAuthorizedFile: reads.save,
}));
afterEach(() => vi.resetAllMocks());

const authority = (revisionId: string): FileReadAuthority => ({
  libraryId: "library",
  storeEpoch: "epoch",
  contentRoutingContext: { kind: "project", projectId: "project" },
  readSource: { kind: "document_revision", document_id: "document", revision_id: revisionId },
});
const content =
  ':attachment{kind="file" source="nodex://files/shared" name="stale.md" mime="text/markdown"}';

test("a historical attachment opens its captured version in a viewer, including after a scope change", async () => {
  reads.metadata.mockImplementation(async (scope: FileReadAuthority) => ({
    file_id: "shared",
    default_name:
      scope.readSource.kind === "document_revision"
        ? `${scope.readSource.revision_id}.md`
        : "wrong.md",
    mime_type: "text/markdown",
    byte_length: 16,
    version: 1,
    blob_etag: "captured",
  }));
  reads.bytes.mockImplementation(async (scope: FileReadAuthority) => {
    if (scope.readSource.kind !== "document_revision")
      throw new Error("Unexpected current File read");
    if (scope.readSource.revision_id === "unresolved") throw new Error("Exact target unavailable");
    return {
      bytes: new TextEncoder().encode("# Captured notes"),
      mimeType: "text/markdown",
      etag: "captured",
    };
  });
  reads.save.mockResolvedValue(undefined);
  const preview = (scope: FileReadAuthority) => (
    <>
      <ReadonlyMarkdownBlockNotePreview
        fileAuthority={scope}
        content={content}
        projectId="project"
        pageId="page"
        historyId={
          scope.readSource.kind === "document_revision" ? scope.readSource.revision_id : ""
        }
      />
      <NodexModalHost />
    </>
  );
  const view = render(preview(authority("old")));
  const chip = await view.findByRole("button", { name: "Open old.md" });
  await act(async () => {
    fireEvent.click(chip);
    await Promise.resolve();
  });
  const viewer = await view.findByRole("dialog");
  expect(await within(viewer).findByRole("heading", { name: "Captured notes" })).toBeDefined();
  expect(within(viewer).getByText("Markdown · 16 B")).toBeDefined();
  await act(async () => {
    fireEvent.click(within(viewer).getByRole("button", { name: "Save…" }));
    await Promise.resolve();
  });
  expect(reads.save).toHaveBeenCalledWith(
    expect.objectContaining({ readSource: authority("old").readSource }),
    "nodex://files/shared",
    "old.md",
  );
  await act(async () => {
    fireEvent.keyDown(viewer, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  view.rerender(preview(authority("unresolved")));
  const unavailable = await view.findByRole("button", { name: "Open unresolved.md" });
  await act(async () => {
    fireEvent.click(unavailable);
    await Promise.resolve();
  });
  expect(
    await within(await view.findByRole("dialog")).findByText("This File is no longer available."),
  ).toBeDefined();
  expect(reads.bytes.mock.calls.map(([scope]) => scope.readSource)).toEqual([
    authority("old").readSource,
    authority("unresolved").readSource,
  ]);
  view.unmount();
});

test("a merged preview uses per-File bindings and refuses references missing from its manifest", async () => {
  const { createFilePreviewRuntime } = await import("./file-runtime");
  reads.metadata.mockResolvedValue({
    file_id: "captured",
    default_name: "frozen.txt",
    mime_type: "text/plain",
    byte_length: 3,
    version: 1,
    blob_etag: "old",
  });
  reads.bytes.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "text/plain",
    etag: "old",
  });
  const base = {
    libraryId: "library",
    storeEpoch: "epoch",
    contentRoutingContext: { kind: "project", projectId: "project" },
  } as const;
  const runtime = createFilePreviewRuntime({
    ...base,
    bindings: {
      captured: {
        file_id: "captured",
        version: 1,
        source: { kind: "recovery_draft", document_id: "document", draft_id: "draft" },
      },
      later: { file_id: "later", version: 3, source: { kind: "page", page_id: "page" } },
    },
  });
  try {
    await runtime.read("nodex://files/captured");
    await runtime.read("nodex://files/later");
    expect(reads.bytes.mock.calls.map(([scope]) => scope)).toEqual([
      {
        ...base,
        version: 1,
        readSource: { kind: "recovery_draft", document_id: "document", draft_id: "draft" },
      },
      { ...base, version: 3, readSource: { kind: "page", page_id: "page" } },
    ]);
    expect(runtime.snapshot("nodex://files/unresolved").contentError).toMatch(
      /no exact File binding/,
    );
    await expect(runtime.read("nodex://files/unresolved")).rejects.toThrow(/no exact File binding/);
    await expect(runtime.save("nodex://files/unresolved", "secret.txt")).rejects.toThrow(
      /no exact File binding/,
    );
    expect(reads.bytes).toHaveBeenCalledTimes(2);
    expect(reads.save).not.toHaveBeenCalled();
  } finally {
    runtime.release();
  }
});
