import { describe, expect, test } from "bun:test";
import { TooltipProvider } from "../../ui/tooltip";
import { StageThreadsDevStoryPage, StageThreadsInlineDiffPreviewCard } from "./stage-threads-dev-story";
import { buildMockStandaloneDiffItem } from "./stage-threads-dev-story-data";
import { STAGE_THREADS_STORY_DEFAULT_PRESET } from "./stage-threads-dev-story-data";
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

  test("renders the scene shell without the old control sidebar", async () => {
    const { container, getByText, queryByText } = render(
      <TooltipProvider>
        <StageThreadsDevStoryPage {...STAGE_THREADS_STORY_DEFAULT_PRESET.controls} />
      </TooltipProvider>,
    );

    expect(getByText("Threads Panel").textContent).toBe("Threads Panel");
    expect(textContent(container).includes("Storybook Controls")).toBeTrue();
    expect(queryByText("Threads Panel Story") === null).toBeTrue();
    expect(queryByText("Overview") === null).toBeTrue();
  });
});
