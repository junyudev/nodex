import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("./stage-threads", () => ({
  StageThreads: () => createElement("div", { "data-stage-threads": "mock" }),
}));

mock.module("./tools/file-change-tool-call", () => ({
  FileChangeToolCall: ({ defaultExpanded }: { defaultExpanded?: boolean }) =>
    createElement("div", { "data-inline-diff-preview": defaultExpanded ? "expanded" : "collapsed" }),
}));

describe("StageThreadsDevStoryPage", () => {
  test("renders the always-visible inline diff preview card", async () => {
    const { StageThreadsDevStoryPage } = await import("./stage-threads-dev-story");

    const markup = renderToStaticMarkup(
      createElement(StageThreadsDevStoryPage, {
        onExit: () => undefined,
      }),
    );

    expect(markup.includes("Inline Diff Preview")).toBeTrue();
    expect(markup.includes("Always-visible mock data")).toBeTrue();
    expect(markup.includes("Dev story sans font size")).toBeTrue();
    expect(markup.includes("Dev story code font size")).toBeTrue();
    expect(markup.includes("data-inline-diff-preview=\"expanded\"")).toBeTrue();
  });
});
