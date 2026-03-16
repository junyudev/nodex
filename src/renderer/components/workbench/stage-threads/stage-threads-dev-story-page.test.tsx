import { describe, expect, test } from "bun:test";
import { buildMockStandaloneDiffItem } from "./stage-threads-dev-story-data";
import { StageThreadsInlineDiffPreviewCard } from "./stage-threads-dev-story";
import { render, textContent } from "../../../test/dom";

describe("StageThreadsInlineDiffPreviewCard", () => {
  test("renders the always-visible inline diff preview card", async () => {
    const { container, getByText } = render(
      <StageThreadsInlineDiffPreviewCard item={buildMockStandaloneDiffItem()} />,
    );

    expect(getByText("Inline Diff Preview").textContent).toBe("Inline Diff Preview");
    expect(textContent(container).includes("Always-visible mock data")).toBeTrue();
    expect(getByText("file-change-tool-call.tsx").textContent?.trim()).toBe("file-change-tool-call.tsx");
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull();
  });
});
