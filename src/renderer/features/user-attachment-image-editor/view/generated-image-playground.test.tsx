import { act, useState } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../../test/dom";
import { TestQueryProvider } from "../../../test/query";
import type { GeneratedImageDescriptor, PlaygroundTool } from "@/lib/content-image";
import type { ImageComment } from "../model/types";
import { GeneratedImagePlayground } from "./generated-image-playground";

const IMAGE_SRC = "data:image/png;base64,AQID";
const IMAGES: GeneratedImageDescriptor[] = [1, 2].map((number) => ({
  id: `image-${number}`,
  alt: `Generated image ${number}`,
  attachmentSrc: IMAGE_SRC,
  generatedOrdinal: number,
  groupId: "turn-1",
  source: "generated",
  src: IMAGE_SRC,
  status: "ready",
}));

const ignoreSendComments = (): void => undefined;

function PlaygroundHarness({
  onSendComments = ignoreSendComments,
}: {
  onSendComments?: () => void;
}) {
  const [activeId, setActiveId] = useState(IMAGES[0]!.id);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [comments, setComments] = useState<Readonly<Record<string, readonly ImageComment[]>>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set([IMAGES[0]!.id]));
  const [tool, setTool] = useState<PlaygroundTool>("navigate");
  const [zoom, setZoom] = useState(100);

  return (
    <TestQueryProvider>
      <div className="h-[700px] w-[800px]">
        <GeneratedImagePlayground
          activeDraftImageId={activeDraftId}
          activeImageId={activeId}
          commentsByImageId={comments}
          groups={[{ id: "turn-1", images: IMAGES, turnStartedAtMs: null }]}
          selectedImageIds={selected}
          tool={tool}
          zoomPercent={zoom}
          onActiveDraftImageIdChange={setActiveDraftId}
          onCommentsChange={(imageId, nextComments) => {
            setComments((current) => ({ ...current, [imageId]: nextComments }));
          }}
          onImageActivate={(image) => {
            if (tool === "navigate") {
              setActiveId(image.id);
              setSelected(new Set([image.id]));
              return;
            }
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(image.id)) next.delete(image.id);
              else next.add(image.id);
              return next;
            });
          }}
          onResolvedSource={() => undefined}
          onSendComments={onSendComments}
          onToolChange={setTool}
          onZoomPercentChange={setZoom}
        />
      </div>
    </TestQueryProvider>
  );
}

function FailedImageHarness() {
  const failedImage: GeneratedImageDescriptor = {
    ...IMAGES[0]!,
    id: "failed-image",
    alt: "Failed generated image",
    status: "failed",
  };
  return (
    <TestQueryProvider>
      <div className="h-[700px] w-[800px]">
        <GeneratedImagePlayground
          activeDraftImageId={null}
          activeImageId={failedImage.id}
          commentsByImageId={{}}
          groups={[{ id: "turn-1", images: [failedImage], turnStartedAtMs: null }]}
          selectedImageIds={new Set([failedImage.id])}
          tool="navigate"
          zoomPercent={100}
          onActiveDraftImageIdChange={() => undefined}
          onCommentsChange={() => undefined}
          onImageActivate={() => undefined}
          onResolvedSource={() => undefined}
          onSendComments={() => undefined}
          onToolChange={() => undefined}
          onZoomPercentChange={() => undefined}
        />
      </div>
    </TestQueryProvider>
  );
}

describe("GeneratedImagePlayground", () => {
  test("moves between focused selection and multi-select ownership", async () => {
    const view = render(<PlaygroundHarness />);
    const first = view.getByRole("button", { name: "Generated image 1" });
    const second = view.getByRole("button", { name: "Generated image 2" });

    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Multi-select" }));
      fireEvent.click(second);
    });

    await waitFor(() => expect(second.getAttribute("aria-pressed")).toBe("true"));
    expect(view.getByRole("button", { name: "Multi-select" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("exposes the multi-image comment surfaces and disabled send state", async () => {
    const onSendComments = vi.fn();
    const view = render(<PlaygroundHarness onSendComments={onSendComments} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Comment" }));
    });

    expect(view.getByText("Add comments on multiple images to batch edit them")).toBeTruthy();
    expect(view.getByRole("button", { name: "Comment on Generated image 1" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Comment on Generated image 2" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(onSendComments).not.toHaveBeenCalled();
  });

  test("lets a failed generated asset retry its current source", async () => {
    const view = render(<FailedImageHarness />);
    expect(view.getByRole("alert")).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
    });

    await waitFor(() =>
      expect(view.getByRole("button", { name: "Failed generated image" })).toBeTruthy(),
    );
  });
});
