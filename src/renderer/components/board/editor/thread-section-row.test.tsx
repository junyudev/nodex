import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { render, textContent } from "../../../test/dom";
import { ThreadSectionRow, type ThreadSectionRowProps } from "./thread-section-row";

function buildProps(overrides?: Partial<ThreadSectionRowProps>): ThreadSectionRowProps {
  return {
    blockId: "section-1",
    label: "Investigate parser",
    threadId: "thr_1",
    thread: {
      threadId: "thr_1",
      threadName: "Parser thread",
      threadPreview: "Inspect bucketization output",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      updatedAt: Date.now() - 5_000,
    },
    pending: false,
    canOpenThread: true,
    canSend: true,
    onLabelChange: () => {},
    onOpenThread: () => {},
    onSend: () => {},
    ...overrides,
  };
}

describe("ThreadSectionRow", () => {
  test("renders the section label, state, and thread name", () => {
    const { container } = render(
      <ThreadSectionRow
        {...buildProps({
          thread: {
            ...buildProps().thread!,
            threadName: "**Parser** [thread](https://example.com)",
          },
        })}
      />,
    );

    const content = textContent(container);
    expect(content.includes("Investigate parser")).toBe(true);
    expect(content.includes("Ready")).toBe(true);
    expect(content.includes("Parser thread")).toBe(true);
    expect(content.includes("**Parser**")).toBe(false);
    expect(content.includes("Send")).toBe(true);
  });

  test("invokes open and send handlers when actions are available", () => {
    const opened: string[] = [];
    const sent: string[] = [];
    const { getByRole } = render(
      <ThreadSectionRow
        {...buildProps({
          onOpenThread: (threadId) => {
            opened.push(threadId);
          },
          onSend: (blockId) => {
            sent.push(blockId);
          },
        })}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Open" }));
    fireEvent.click(getByRole("button", { name: "Send" }));

    expect(opened[0]).toBe("thr_1");
    expect(sent[0]).toBe("section-1");
  });
});
