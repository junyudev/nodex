import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { renderWithMaitai } from "@/test/thread-maitai";
import { MarkdownRenderer } from "./markdown-renderer";
import { ResponseAnnotationContext } from "../../response-annotation-context";

test("inline annotation references disclose only the numbered source supplied with this response", async () => {
  const annotation = {
    id: "note",
    text: "The selected sentence",
    annotation: "Explain the exception",
    source: {
      threadId: "thread",
      messageId: "source",
      startOffset: 0,
      endOffset: 21,
      rangeText: "The selected sentence",
    },
  };
  const view = renderWithMaitai(
    <ResponseAnnotationContext value={[annotation]}>
      <MarkdownRenderer
        dialect="conversation"
        content={
          'Explanation :codex-annotation{index="1"}. Unknown :codex-annotation{index="2"}.\n\n`:codex-annotation{index="1"}`'
        }
      />
    </ResponseAnnotationContext>,
  );
  const reference = await view.findByRole("button", { name: "Annotation 1" });
  expect(view.queryByRole("button", { name: "Annotation 2" })).toBeNull();
  expect(view.getByText(':codex-annotation{index="1"}')).toBeTruthy();
  expect(view.getAllByRole("button", { name: "Annotation 1" })).toHaveLength(1);
  await act(async () => {
    fireEvent.click(reference);
    await Promise.resolve();
  });
  await waitFor(() => expect(view.getByText("The selected sentence")).toBeTruthy());
  expect(view.getByText("Explain the exception")).toBeTruthy();
});
