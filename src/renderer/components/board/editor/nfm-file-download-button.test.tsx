import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  focus: vi.fn(),
  readImageDataUrl: vi.fn(),
  materialize: vi.fn(),
  download: vi.fn(),
  failure: vi.fn(),
  source: "nodex-file:file-1",
}));

vi.mock("@blocknote/react", () => ({
  useDictionary: () => ({
    formatting_toolbar: { file_download: { tooltip: { file: "Download" } } },
  }),
  useBlockNoteEditor: () => ({ focus: runtime.focus }),
  useEditorState: () => ({ type: "image", props: { url: runtime.source, name: "Diagram" } }),
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: ({ label, onClick }: { label: string; onClick: () => void }) => (
        <button onClick={onClick}>{label}</button>
      ),
    },
  }),
}));
vi.mock("./file-runtime", () => ({
  useFilePlacementRuntime: () => ({ readImageDataUrl: runtime.readImageDataUrl }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: runtime.failure } }));
vi.mock("@/lib/content-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content-image")>()),
  materializeImageSourceAsDataUrl: runtime.materialize,
  downloadImageDataUrl: runtime.download,
}));

import { fileSource } from "../../../../shared/file-resources";
import { NfmFileDownloadButton } from "./nfm-file-download-button";

beforeEach(() => {
  vi.clearAllMocks();
  runtime.source = fileSource("file-1");
  runtime.readImageDataUrl.mockResolvedValue("data:image/png;base64,aW1hZ2U=");
  runtime.download.mockResolvedValue(undefined);
});

test("focuses the editor before reading the exact File and downloading its named image", async () => {
  render(<NfmFileDownloadButton />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(runtime.download).toHaveBeenCalledWith("data:image/png;base64,aW1hZ2U=", "Diagram"),
  );
  expect(runtime.focus.mock.invocationCallOrder[0]).toBeLessThan(
    runtime.readImageDataUrl.mock.invocationCallOrder[0]!,
  );
  expect(runtime.readImageDataUrl).toHaveBeenCalledWith(fileSource("file-1"));
  expect(runtime.materialize).not.toHaveBeenCalled();
  expect(runtime.failure).not.toHaveBeenCalled();
});

test("reports a rejected read once without starting a download", async () => {
  runtime.readImageDataUrl.mockRejectedValue(new Error("File unavailable"));
  render(<NfmFileDownloadButton />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(runtime.failure).toHaveBeenCalledExactlyOnceWith("Could not download image", {
      id: "editor-download-image",
    }),
  );
  expect(runtime.download).not.toHaveBeenCalled();
});
