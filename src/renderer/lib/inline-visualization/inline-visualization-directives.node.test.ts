import { describe, expect, test } from "vite-plus/test";
import { unified } from "unified";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  remarkInlineVisualizations,
  resolveInlineVisualizationSourceThreadId,
} from "./inline-visualization-directives";
import { stripCodexRemarkDirectiveLines } from "../../../shared/codex-remark-directives";

describe("inline visualization directives", () => {
  test("parses ordered, quoted and unquoted attributes without treating literal code as executable", async () => {
    const processor = unified().use(remarkInlineVisualizations).freeze();
    const content =
      '::codex-inline-vis{threadId="source-id" mode=wide file=sample.html}\n\n```md\n::codex-inline-vis{file="literal.html"}\n```\n\n`::codex-inline-vis{file="inline.html"}`';
    const tree = await processor.run(
      fromMarkdown(content, {
        extensions: processor.data("micromarkExtensions"),
        mdastExtensions: processor.data("fromMarkdownExtensions"),
      }),
    );
    expect(tree.children[0]).toMatchObject({
      type: "leafDirective",
      data: {
        hName: "nodex-visualization",
        hProperties: { file: "sample.html", threadid: "source-id", mode: "wide" },
      },
    });
    expect(tree.children[1]).toMatchObject({
      type: "code",
      value: '::codex-inline-vis{file="literal.html"}',
    });
    expect(tree.children[2]).toMatchObject({
      type: "paragraph",
      children: [{ type: "inlineCode" }],
    });
  });
  test("preserves renderable directives and fenced examples while removing metadata", () => {
    const content =
      'Text\n::inbox-item{title="Hidden"}\n::codex-inline-vis{file="sample.html"}\n```\n::inbox-item{title="Literal"}\n```';
    expect(stripCodexRemarkDirectiveLines(content, { keepInlineVisualizations: true })).toBe(
      'Text\n\n::codex-inline-vis{file="sample.html"}\n```\n::inbox-item{title="Literal"}\n```',
    );
    expect(stripCodexRemarkDirectiveLines('::codex-inline-vis{file="sample.html"}')).toBe("");
  });
  test("accepts only declared display or matching native file ownership", () => {
    const input = {
      file: "sample.html",
      threadId: "visible",
      changedFilePaths: [
        "/other/no-match.html",
        "C:\\home\\visualizations\\2026\\10\\12\\source-native\\sample.html",
      ],
    };
    expect(resolveInlineVisualizationSourceThreadId(input)).toBe("source-native");
    expect(
      resolveInlineVisualizationSourceThreadId({ ...input, declaredSourceThreadId: "declared" }),
    ).toBe("source-native");
    expect(resolveInlineVisualizationSourceThreadId({ ...input, file: "different.html" })).toBe(
      "visible",
    );
  });
});
