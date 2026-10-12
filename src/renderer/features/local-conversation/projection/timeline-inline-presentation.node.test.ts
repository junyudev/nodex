import { expect, test } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { resolveTimelineInlinePresentation } from "./timeline-inline-presentation";

const agent = (text: string): Extract<ThreadItem, { type: "agentMessage" }> => ({
  type: "agentMessage",
  id: "artifact",
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});

test("reads only the declared native inline Markdown channel", () => {
  expect(
    resolveTimelineInlinePresentation(agent("[FINAL]\n::codex-realtime-inline{}\n# Result"), {
      type: "inlineMarkdown",
    }),
  ).toEqual({ type: "markdown", content: "# Result" });
  expect(
    resolveTimelineInlinePresentation(agent("::codex-realtime-inline{}"), {
      type: "inlineMarkdown",
    }),
  ).toBeNull();
  expect(resolveTimelineInlinePresentation(agent("[FIN"), { type: "inlineMarkdown" })).toBeNull();
});

test("indexes native visualization directives while skipping literal fenced examples", () => {
  const text =
    '```md\n::codex-inline-vis{file="literal.html"}\n```\n::codex-inline-vis{file="chart.html" threadId="source"}\nvisualize{"path":"/tmp/table.html"}';
  expect(
    resolveTimelineInlinePresentation(agent(text), { type: "inlineVisualization", index: 0 }),
  ).toEqual({
    type: "visualization",
    file: "chart.html",
    sourceThreadId: "source",
  });
  expect(
    resolveTimelineInlinePresentation(agent(text), { type: "inlineVisualization", index: 1 }),
  ).toEqual({ type: "visualization", file: "table.html", sourceThreadId: null });
  expect(
    resolveTimelineInlinePresentation(agent(text), { type: "inlineVisualization", index: 2 }),
  ).toBeNull();
  expect(
    resolveTimelineInlinePresentation(agent('visualize{"path":"C:\\\\tmp\\\\chart.html"}'), {
      type: "inlineVisualization",
      index: 0,
    }),
  ).toEqual({ type: "visualization", file: "chart.html", sourceThreadId: null });
});

test("native visualization promotions require their declared narrow directive grammar", () => {
  for (const text of [
    '::codex-inline-vis{file="chart.html" mode="wide"}',
    '::codex-inline-vis{threadId="source" file="chart.html"}',
    "::codex-inline-vis{file=chart.html}",
  ])
    expect(
      resolveTimelineInlinePresentation(agent(text), { type: "inlineVisualization", index: 0 }),
    ).toBeNull();
});
