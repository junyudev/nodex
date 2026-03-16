import { describe, expect, mock, test } from "bun:test";
import { render, textContent } from "../../../test/dom";
import { CARD_STAGE_STORY_DEFAULT_PRESET } from "./card-stage-dev-story-data";

describe("card stage dev story", () => {
  test("renders the Storybook scene shell", async () => {
    mock.module("../card-stage", () => ({
      CardStage: () => <div>Mock CardStage Preview</div>,
    }));

    const { CardStageDevStoryPage } = await import("./card-stage-dev-story");
    const { container, getByText, queryByText } = render(
      <CardStageDevStoryPage {...CARD_STAGE_STORY_DEFAULT_PRESET.controls} renderPreview={false} />,
    );

    expect(getByText("Card Stage").textContent).toBe("Card Stage");
    expect(textContent(container).includes("Controls panel")).toBeTrue();
    expect(queryByText("Card Stage Story") === null).toBeTrue();
    expect(queryByText("Dense Threads") === null).toBeTrue();
    expect(getByText("Preview disabled for tests.").textContent).toBe("Preview disabled for tests.");
  });
});
