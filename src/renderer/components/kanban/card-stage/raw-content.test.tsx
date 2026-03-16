import { describe, expect, test } from "bun:test";
import { render, textContent } from "../../../test/dom";

describe("card stage raw content", () => {
  test("renders exact raw content in a read-only chrome", async () => {
    const { CardStageRawContent } = await import("./raw-content");
    const { container, getByText } = render(
      <CardStageRawContent content={`# Heading\n\n- item 1\n- item 2\n<image source="nodex://assets/demo.png" />`} />,
    );

    expect(getByText("Raw format").textContent).toBe("Raw format");
    expect(getByText("Read-only").textContent).toBe("Read-only");
    expect(textContent(container).includes('<image source="nodex://assets/demo.png" />')).toBeTrue();
  });

  test("renders an empty-state hint when the description is blank", async () => {
    const { CardStageRawContent } = await import("./raw-content");
    const { getByText } = render(<CardStageRawContent content="" />);

    expect(getByText("Description is empty.").textContent).toBe("Description is empty.");
  });
});
