import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
} from "../../../shared/block-documents/page-document";
import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import type { DocumentSessionRegistry, EditorSurfaceLease } from "@/lib/document-session-registry";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import type { PrimaryPageBlockDocumentDescriptor } from "./block-document-surface";
import { PageEditorSessionSurface } from "./page-editor-session-surface";

vi.mock("./block-document-surface", () => ({
  BlockDocumentSurfaceFailureState: () => <div role="alert">Failed</div>,
  OwnedBlockDocumentRuntimeSurface: ({ onReload }: { readonly onReload: () => Promise<void> }) => (
    <button onClick={() => void onReload()}>Reload document</button>
  ),
}));

const descriptor: PrimaryPageBlockDocumentDescriptor = {
  libraryId: "library",
  routingContext: { kind: "library" },
  ownerBlockId: "page",
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "document",
  storeEpoch: "store",
  generation: 1,
  headSeq: 0,
  schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
  schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array([0]) },
};
const createLease = () => ({
  runtime: {} as BlockDocumentSurfaceRuntime,
  claimView: vi.fn(() => 1),
  releaseView: vi.fn(() => true),
  connect: vi.fn(async () => {}),
});

describe("Page editor session surface", () => {
  test("retains an equivalent document and reacquires a changed generation", async () => {
    const first = createLease();
    const second = createLease();
    const acquire = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const registry = {
      acquire,
      dispose: vi.fn(async () => {}),
    } as unknown as DocumentSessionRegistry;
    const props = { sessionKey: "tab", descriptor, isActive: true, registry, children: () => null };
    const view = render(<PageEditorSessionSurface {...props} />);
    await view.findByRole("button", { name: "Reload document" });
    view.rerender(
      <PageEditorSessionSurface {...props} descriptor={{ ...descriptor, headSeq: 2 }} />,
    );
    expect(acquire).toHaveBeenCalledOnce();
    view.rerender(
      <PageEditorSessionSurface {...props} descriptor={{ ...descriptor, generation: 2 }} />,
    );
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    expect(first.releaseView).toHaveBeenCalledWith(1, { persist: true });
    expect(acquire.mock.calls[1]?.[0].descriptor.generation).toBe(2);
    view.unmount();
    expect(second.releaseView).toHaveBeenCalledOnce();
  });

  test("restarts a disposed lease and applies the latest unmount policy", async () => {
    const first = createLease();
    const second = createLease();
    const acquire = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const dispose = vi.fn(async () => {});
    const registry = { acquire, dispose } as unknown as DocumentSessionRegistry;
    const onReload = vi.fn(async () => {});
    const props = {
      sessionKey: "tab",
      descriptor,
      isActive: true,
      registry,
      onReload,
      children: () => null,
    };
    const view = render(<PageEditorSessionSurface {...props} />);
    const reload = await view.findByRole("button", { name: "Reload document" });
    await act(async () => {
      fireEvent.click(reload);
      await Promise.resolve();
    });
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    expect(dispose).toHaveBeenCalledWith("tab", first as unknown as EditorSurfaceLease);
    expect(onReload).toHaveBeenCalledOnce();
    view.rerender(<PageEditorSessionSurface {...props} retainModelOnUnmount={false} />);
    expect(acquire).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(second.releaseView).toHaveBeenCalledWith(1, { persist: false });
    expect(dispose).toHaveBeenCalledWith("tab", second as unknown as EditorSurfaceLease);
  });
});
