import { act, useState } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../../test/dom";
import { TestQueryProvider } from "../../../test/query";
import type { GeneratedImageDescriptor } from "@/lib/content-image";
import { GeneratedImageRail } from "./generated-image-rail";

const IMAGE_SRC = "data:image/png;base64,AQID";
const IMAGES: readonly GeneratedImageDescriptor[] = [1, 2, 3].map((number) => ({
  id: `image-${number}`,
  alt: `Generated image ${number}`,
  attachmentSrc: IMAGE_SRC,
  generatedOrdinal: number,
  groupId: "turn",
  source: "generated",
  src: IMAGE_SRC,
  status: "ready",
}));

function RailHarness() {
  const [activeId, setActiveId] = useState(IMAGES[0]!.id);
  return (
    <TestQueryProvider>
      <div className="h-36">
        <GeneratedImageRail
          activeId={activeId}
          images={IMAGES}
          onSelect={(image) => setActiveId(image.id)}
        />
      </div>
    </TestQueryProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("GeneratedImageRail", () => {
  test("supports pointer, arrow-key, and wheel selection", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const view = render(<RailHarness />);
    const rail = view.getByLabelText("Generated images");
    Object.defineProperties(rail, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 174 },
    });
    const second = view.getByRole("button", { name: "Generated image 2" });

    await act(async () => {
      fireEvent.click(second);
    });
    await waitFor(() => expect(second.getAttribute("aria-current")).toBe("true"));

    await act(async () => {
      fireEvent.keyDown(second, { key: "ArrowDown" });
    });
    const third = view.getByRole("button", { name: "Generated image 3" });
    await waitFor(() => expect(third.getAttribute("aria-current")).toBe("true"));

    await act(async () => {
      fireEvent.wheel(rail, { deltaMode: 0, deltaY: -108 });
    });
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Generated image 1" }).getAttribute("aria-current"),
      ).toBe("true"),
    );
    expect(scrollTo).toHaveBeenCalled();
  });
});
