import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMockStandaloneDiffItem } from "./stage-threads-dev-story-data";
import { StageThreadsInlineDiffPreviewCard } from "./stage-threads-dev-story";

describe("StageThreadsInlineDiffPreviewCard", () => {
  test("renders the always-visible inline diff preview card", async () => {
    const markup = renderToStaticMarkup(
      createElement(StageThreadsInlineDiffPreviewCard, {
        item: buildMockStandaloneDiffItem(),
      }),
    );

    expect(markup.includes("Inline Diff Preview")).toBeTrue();
    expect(markup.includes("Always-visible mock data")).toBeTrue();
    expect(markup.includes("file-change-tool-call.tsx")).toBeTrue();
    expect(markup.includes("aria-expanded=\"true\"")).toBeTrue();
  });
});
