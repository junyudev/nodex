import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { TestQueryProvider } from "../../../../../test/query";
import { ConversationToolOutputProvider } from "../../conversation-tool-output-context";
import { LazyToolOutput } from "./lazy-tool-output";

const reference = { sessionId: "native", nativeMessageId: "result-record", toolUseId: "read-1" };

test("queries native full output only when requested and retains the exact owner tuple", async () => {
  const read = vi.fn(async () => ({
    text: "Tail beyond the resident transcript budget",
    truncated: false,
    originalBytes: 100_000,
  }));
  const view = render(
    <TestQueryProvider>
      <ConversationToolOutputProvider conversationId="thread" readToolOutput={read}>
        <LazyToolOutput reference={reference} />
      </ConversationToolOutputProvider>
    </TestQueryProvider>,
  );
  expect(read).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Show full output" }));
  });
  await view.findByText("Tail beyond the resident transcript budget");
  expect(read).toHaveBeenCalledExactlyOnceWith(reference);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Hide full output" }));
  });
  expect(view.queryByText("Tail beyond the resident transcript budget")).toBeNull();
});

test("reports the lazy display cap and retries failed owner reads without adding transcript data", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("Native result unavailable"))
    .mockResolvedValue({ text: "Bounded output", truncated: true, originalBytes: 700_000 });
  const view = render(
    <TestQueryProvider>
      <ConversationToolOutputProvider conversationId="other-thread" readToolOutput={read}>
        <LazyToolOutput reference={reference} />
      </ConversationToolOutputProvider>
    </TestQueryProvider>,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Show full output" }));
  });
  await act(async () => {
    fireEvent.click(await view.findByRole("button", { name: "Retry output" }));
  });
  await view.findByText("Bounded output");
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.getByText("Output exceeds the display limit (700,000 bytes)")).toBeDefined();
});
