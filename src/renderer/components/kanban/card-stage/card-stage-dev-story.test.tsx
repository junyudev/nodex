import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

describe("card stage dev story", () => {
  test("renders the story shell and routing hint", async () => {
    mock.module("../card-stage", () => ({
      CardStage: () => <div>Mock CardStage Preview</div>,
    }));

    const { CardStageDevStoryPage } = await import("./card-stage-dev-story");
    const markup = renderToStaticMarkup(
      <CardStageDevStoryPage onExit={() => undefined} renderPreview={false} />,
    );

    expect(markup.includes("Card Stage Story")).toBeTrue();
    expect(markup.includes("?dev-story=card-stage")).toBeTrue();
    expect(markup.includes("Dense Threads")).toBeTrue();
    expect(markup.includes("Dev story sans font size")).toBeTrue();
    expect(markup.includes("Dev story code font size")).toBeTrue();
    expect(markup.includes("Preview disabled for tests.")).toBeTrue();
  });
});
