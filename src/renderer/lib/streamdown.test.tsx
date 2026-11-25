import { describe, expect, test } from "vite-plus/test";
import { streamdownComponents, StreamdownMermaidError } from "./streamdown";
import { ConversationTokenRenderer } from "./markdown/conversation-token-renderer";
import { MarkdownDocumentRenderer } from "./markdown/markdown-document-renderer";
import { readMarkdownSyntaxPolicy } from "./markdown/markdown-policy";
import { render, textContent } from "../test/dom";

describe("StreamdownMermaidError", () => {
  test("renders a safe mermaid error fallback", () => {
    const { container } = render(
      <StreamdownMermaidError
        chart={"graph TD\nA-->B"}
        error="Invalid Mermaid diagram."
        retry={() => {}}
      />,
    );

    expect(textContent(container).includes("Mermaid Error")).toBe(true);
    expect(textContent(container).includes("Invalid Mermaid diagram.")).toBe(true);
  });
});

describe("read-only Markdown tables", () => {
  const tableProps = {
    source: [
      "| **Short** | | Title |",
      "| ---: | --- | --- |",
      "| A much longer sentence in this cell. | | |",
    ].join("\n"),
    streaming: false,
    animate: false,
    adaptive: false,
    components: streamdownComponents,
  };
  const policy = readMarkdownSyntaxPolicy({
    preserveLineBreaks: false,
    visualizations: false,
    fileMedia: false,
    repairIncomplete: false,
  });

  test.each([
    { path: "conversation", view: <ConversationTokenRenderer {...tableProps} /> },
    { path: "document", view: <MarkdownDocumentRenderer {...tableProps} policy={policy} /> },
  ])(
    "classifies header and body cells and preserves alignment in $path Markdown",
    async ({ view }) => {
      const { findByRole } = render(view);

      const table = (await findByRole("table")) as HTMLTableElement;
      expect(table.dataset.nfmTableLayout).toBe("auto");
      expect(table.querySelectorAll("col")).toHaveLength(3);
      expect(table.tHead?.rows[0]?.cells[0]?.style.textAlign).toBe("right");
      expect(
        Array.from(table.rows, (row) => Array.from(row.cells, (cell) => cell.dataset.nfmCellFit)),
      ).toEqual([
        ["short", "blank", "short"],
        ["long", "blank", undefined],
      ]);
    },
  );
});
