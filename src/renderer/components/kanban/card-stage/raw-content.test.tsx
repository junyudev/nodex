import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

describe("card stage raw content", () => {
  test("renders exact raw content in a read-only chrome", async () => {
    const { CardStageRawContent } = await import("./raw-content");
    const markup = renderToStaticMarkup(
      <CardStageRawContent content={`# Heading\n\n- item 1\n- item 2\n<image source="nodex://assets/demo.png" />`} />,
    );

    expect(markup.includes("Raw format")).toBeTrue();
    expect(markup.includes("Read-only")).toBeTrue();
    expect(markup.includes("&lt;image source=&quot;nodex://assets/demo.png&quot; /&gt;")).toBeTrue();
  });

  test("renders an empty-state hint when the description is blank", async () => {
    const { CardStageRawContent } = await import("./raw-content");
    const markup = renderToStaticMarkup(<CardStageRawContent content="" />);

    expect(markup.includes("Description is empty.")).toBeTrue();
  });
});
