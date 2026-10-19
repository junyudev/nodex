import { fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { render } from "@/test/dom";
import { ReferencedBySection } from "./referenced-by-section";

const ITEM = {
  sourcePageId: "page:source",
  sourceBlockId: "block:source",
  sourceTitle: "Source Page",
  locationLabel: "Project / Parent",
  presentations: ["mention", "link"] as const,
  occurrenceCount: 2,
  updatedAt: "2026-08-16T00:00:00.000Z",
};

describe("ReferencedBySection", () => {
  test("stays collapsed by default and opens the exact source Block row", () => {
    const onOpen = vi.fn();
    const view = render(<ReferencedBySection items={[ITEM]} sourcePageCount={1} onOpen={onOpen} />);

    const disclosure = view.getByRole("button", { name: /Referenced by 1/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("Source Page")).toBeNull();

    fireEvent.click(disclosure);
    fireEvent.click(view.getByRole("button", { name: /Source Page/ }));
    expect(onOpen).toHaveBeenCalledWith(ITEM);
  });

  test("does not render the section for an empty authorized result", () => {
    const view = render(
      <ReferencedBySection
        items={[]}
        sourcePageCount={0}
        defaultExpanded
        onOpen={() => undefined}
      />,
    );

    expect(view.container.querySelector("[data-page-backlinks-section]")).toBeNull();
    expect(view.queryByText("Referenced by")).toBeNull();
  });

  test("waits for a known source Page instead of flashing while loading", () => {
    const loadingView = render(
      <ReferencedBySection items={[]} sourcePageCount={0} loading onOpen={() => undefined} />,
    );
    expect(loadingView.queryByText("Referenced by")).toBeNull();

    loadingView.rerender(
      <ReferencedBySection items={[ITEM]} sourcePageCount={1} loading onOpen={() => undefined} />,
    );
    expect(loadingView.getByRole("button", { name: "Referenced by 1" })).toBeTruthy();
  });
});
