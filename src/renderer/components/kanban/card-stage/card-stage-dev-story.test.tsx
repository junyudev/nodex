import { describe, expect, mock, test } from "bun:test";
import { render, textContent } from "../../../test/dom";

describe("card stage dev story", () => {
  test("renders the story shell and routing hint", async () => {
    mock.module("../card-stage", () => ({
      CardStage: () => <div>Mock CardStage Preview</div>,
    }));

    const { CardStageDevStoryPage } = await import("./card-stage-dev-story");
    const { container, getByText } = render(
      <CardStageDevStoryPage onExit={() => undefined} renderPreview={false} />,
    );

    expect(getByText("Card Stage Story").textContent).toBe("Card Stage Story");
    expect(textContent(container).includes("?dev-story=card-stage")).toBeTrue();
    expect(getByText("Dense Threads").textContent).toBe("Dense Threads");
    expect(getByText("Dev story sans font size").textContent).toBe("Dev story sans font size");
    expect(getByText("Dev story code font size").textContent).toBe("Dev story code font size");
    expect(getByText("Preview disabled for tests.").textContent).toBe("Preview disabled for tests.");
  });
});
