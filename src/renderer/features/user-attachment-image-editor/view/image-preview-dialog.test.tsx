import { act, useRef, useState, type ComponentProps } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../../test/dom";
import { TestQueryProvider } from "../../../test/query";
import { ImagePreviewDialog } from "./image-preview-dialog";
import * as resolvedImageAsset from "../adapters/resolved-image-asset";

const IMAGE_DATA_URL = "data:image/png;base64,AQID";

function FocusRestorePreview() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <TestQueryProvider>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open preview
      </button>
      <ImagePreviewDialog
        open={open}
        onOpenChange={setOpen}
        src={IMAGE_DATA_URL}
        finalFocus={() => {
          triggerRef.current?.focus();
          return false;
        }}
      />
    </TestQueryProvider>
  );
}

function renderPreview(props: Partial<ComponentProps<typeof ImagePreviewDialog>> = {}) {
  return render(
    <TestQueryProvider>
      <ImagePreviewDialog
        open
        onOpenChange={() => undefined}
        src={IMAGE_DATA_URL}
        alt="Example image"
        {...props}
      />
    </TestQueryProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ImagePreviewDialog", () => {
  test("does not download an image whose source retires while materializing it", async () => {
    let current = true;
    const download = vi
      .spyOn(resolvedImageAsset, "downloadImageDataUrl")
      .mockImplementation(() => undefined);
    const view = renderPreview({ isCurrent: () => current });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Download image" }));
      current = false;
      await Promise.resolve();
    });
    expect(download).not.toHaveBeenCalled();
  });

  test("offers the optional edit action and closes after accepting it", async () => {
    const onEditImage = vi.fn();
    const onOpenChange = vi.fn();
    const view = renderPreview({ onEditImage, onOpenChange });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit image" }));
    });

    expect(onEditImage).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("supports adjacent-image keyboard navigation", async () => {
    const onPreviousImage = vi.fn();
    const onNextImage = vi.fn();
    renderPreview({ onPreviousImage, onNextImage });

    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowLeft" });
      fireEvent.keyDown(document, { key: "ArrowRight" });
    });

    expect(onPreviousImage).toHaveBeenCalledOnce();
    expect(onNextImage).toHaveBeenCalledOnce();
  });

  test("downloads data URLs through an object URL", async () => {
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const view = renderPreview({ downloadFileName: "diagram.png" });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Download image" }));
      await Promise.resolve();
    });

    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("diagram.png");
  });

  test("delegates focus restoration to the owning trigger", async () => {
    const view = render(<FocusRestorePreview />);
    const trigger = view.getByRole("button", { name: "Open preview" });

    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Close image preview" }));
    });

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("preserves the Board space-to-close shortcut without stealing modified space", async () => {
    const onOpenChange = vi.fn();
    renderPreview({ closeOnSpace: true, onOpenChange });

    await act(async () => {
      fireEvent.keyDown(document, { key: " ", code: "Space", metaKey: true });
      fireEvent.keyDown(document, { key: " ", code: "Space" });
    });

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
