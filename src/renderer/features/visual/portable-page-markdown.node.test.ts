import { expect, test, vi } from "vite-plus/test";
import { writePortableMarkdown, type MarkdownBlock } from "../../../shared/nodex-markdown";
import { writePortablePageMarkdown } from "./portable-page-markdown";
import { visualAdapter } from "./visual-adapter";

vi.mock("./visual-adapter", () => ({ visualAdapter: { capture: vi.fn() } }));

const page = { pageId: "page-id", routingContext: { kind: "library" as const } };
const visual: MarkdownBlock = {
  id: "chart-id",
  type: "codeBlock",
  props: { language: "visual" },
  content: "<nodex.Visualize />",
};

test("Page Markdown uses an embedded snapshot, caption and a portable data table", async () => {
  vi.mocked(visualAdapter.capture).mockResolvedValue({
    diagnostics: [],
    captures: [
      {
        appearance: "light",
        hash: "hash",
        png: Uint8Array.of(1, 2, 3),
        frame: {
          revision: 1,
          width: 12,
          height: 12,
          datum: [],
          text: [],
          diagnostics: [],
          svg: "",
        },
      },
    ],
    resolved: {
      captions: ["Weekly tasks"],
      rows: [
        {
          tasks: [
            { week: "W1", total: 4 },
            { week: "W2", total: 9 },
          ],
        },
      ],
    },
  });
  const markdown = await writePortablePageMarkdown(
    [
      visual,
      { id: "code-id", type: "codeBlock", props: { language: "js" }, content: "let count = 2;" },
    ],
    page,
  );
  expect(markdown).toBe(
    `![Weekly tasks](data:image/png;base64,AQID)\n\nWeekly tasks\n\n| week | total |\n| --- | --- |\n| W1 | 4 |\n| W2 | 9 |\n\n\`\`\`javascript\nlet count = 2;\n\`\`\``,
  );
  expect(writePortableMarkdown([visual]).markdown).toBe("```visual\n<nodex.Visualize />\n```");
});

test("a render failure can still export resolved data and its caption", async () => {
  vi.mocked(visualAdapter.capture).mockResolvedValue({
    diagnostics: [{ severity: "error", code: "render", message: "The figure timed out" }],
    captures: [],
    resolved: { captions: ["Counts"], rows: [{ items: [{ count: 42 }] }] },
  });
  expect(await writePortablePageMarkdown([visual], page)).toBe(
    "Counts\n\n| count |\n| --- |\n| 42 |",
  );
});

test("sparse sources retain their fields without padding every row to the union of columns", async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `id-${index + 1}`,
    [`field-${index + 1}`]: index,
  }));
  vi.mocked(visualAdapter.capture).mockResolvedValue({
    diagnostics: [],
    captures: [],
    resolved: { captions: ["Sparse source"], rows: [{ items }] },
  });
  const markdown = await writePortablePageMarkdown([visual], page);
  expect(markdown).toContain("| Row | Field | Value |\n| --- | --- | --- |");
  expect(markdown).toContain("| 100 | id | id-100 |\n| 100 | field-100 | 99 |");
});
