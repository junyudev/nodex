import { afterEach, describe, expect, test } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import { render, settleAsyncRender, textContent } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CodexThreadSummary } from "@/lib/types";
import {
  resolveThreadMentionChip,
  ThreadMentionInlineContentView,
  ThreadMentionRuntimeProvider,
} from "./thread-mention-chip";

const originalClipboard = navigator.clipboard;

function createThreadSummary(overrides: Partial<CodexThreadSummary> = {}): CodexThreadSummary {
  return {
    threadId: "019-thread",
    projectId: "project-1",
    source: null,
    threadName: "Investigate parser issue",
    threadPreview: "Fallback preview",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  if (descriptor?.configurable) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  }
});

describe("thread mention inline content", () => {
  test("resolves label and state from thread metadata", () => {
    const resolved = resolveThreadMentionChip({
      uuid: "019-thread",
      thread: createThreadSummary({
        threadName: "",
        threadPreview: "First preview line\nSecond",
        archived: true,
      }),
    });

    expect(resolved.label).toBe("First preview line Second");
    expect(resolved.stateLabel).toBe("Archived");
    expect(resolved.shortUuid).toBe("019-thread");

    const missing = resolveThreadMentionChip({ uuid: "019-thread", missing: true });
    expect(missing.label).toBe("Missing thread");
    expect(missing.tone).toBe("error");
  });

  test("opens resolved thread mentions through the runtime callback", async () => {
    let openedThreadId = "";
    const view = render(
      <NodexTooltipProvider>
        <ThreadMentionRuntimeProvider
          value={{
            threads: {
              "019-thread": createThreadSummary(),
            },
            resolvingIds: new Set(),
            openThread: (threadId) => {
              openedThreadId = threadId;
            },
          }}
        >
          <ThreadMentionInlineContentView inlineContent={{ props: { uuid: "019-thread" } }} />
        </ThreadMentionRuntimeProvider>
      </NodexTooltipProvider>,
    );

    const mention = view.getByRole("button");
    expect(textContent(mention)).toBe("Investigate parser issue");
    expect(mention.getAttribute("data-mention-inline-chip")).toBe("true");
    expect(mention.closest('[data-mention-inline-root="true"]')).not.toBeNull();
    expect(view.container.querySelector('[data-mention-inline-guard="start"]')).not.toBeNull();
    expect(view.container.querySelector('[data-mention-inline-guard="end"]')).not.toBeNull();

    mention.dataset.mentionTokenSelected = "true";
    await waitFor(() => {
      const affordance = document.body.querySelector(
        '[data-mention-inline-focus-affordance="true"]',
      );
      if (!affordance || textContent(affordance) !== "Open chat↵") {
        throw new Error("Thread mention focus affordance not open");
      }
    });
    delete mention.dataset.mentionTokenSelected;
    await waitFor(() => {
      if (document.body.querySelector('[data-mention-inline-focus-affordance="true"]')) {
        throw new Error("Thread mention focus affordance did not close");
      }
    });

    fireEvent.click(mention);
    await settleAsyncRender();

    expect(openedThreadId).toBe("019-thread");
  });

  test("opens uncached thread mentions when an opener is available", async () => {
    let openedThreadId = "";
    const view = render(
      <NodexTooltipProvider>
        <ThreadMentionRuntimeProvider
          value={{
            threads: {},
            resolvingIds: new Set(["019-thread"]),
            openThread: (threadId) => {
              openedThreadId = threadId;
            },
          }}
        >
          <ThreadMentionInlineContentView inlineContent={{ props: { uuid: "019-thread" } }} />
        </ThreadMentionRuntimeProvider>
      </NodexTooltipProvider>,
    );

    fireEvent.click(view.getByRole("button"));
    await settleAsyncRender();

    expect(openedThreadId).toBe("019-thread");
    expect(document.body.querySelector('[role="dialog"]') === null).toBe(true);
  });

  test("reveals thread metadata in a hover tooltip", async () => {
    const view = render(
      <NodexTooltipProvider>
        <ThreadMentionRuntimeProvider
          value={{
            threads: {
              "019-thread": createThreadSummary(),
            },
            resolvingIds: new Set(),
            openThread: () => undefined,
          }}
        >
          <ThreadMentionInlineContentView inlineContent={{ props: { uuid: "019-thread" } }} />
        </ThreadMentionRuntimeProvider>
      </NodexTooltipProvider>,
    );

    const mention = view.getByRole("button");
    fireEvent.pointerMove(mention, { pointerType: "mouse" });
    fireEvent.mouseEnter(mention);
    await settleAsyncRender();

    await waitFor(() => {
      const tooltip = document.body.querySelector('[role="tooltip"]');
      if (!tooltip || !textContent(tooltip).includes("Ready · 019-thread")) {
        throw new Error("Thread mention tooltip not open");
      }
    });
  });

  test("copies uuid from unresolved mentions when opening is unavailable", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });

    const view = render(
      <NodexTooltipProvider>
        <ThreadMentionRuntimeProvider
          value={{
            threads: {},
            resolvingIds: new Set(),
          }}
        >
          <ThreadMentionInlineContentView inlineContent={{ props: { uuid: "019-thread" } }} />
        </ThreadMentionRuntimeProvider>
      </NodexTooltipProvider>,
    );

    fireEvent.click(view.getByRole("button"));
    await waitFor(() => {
      if (!textContent(document.body).includes("Copy UUID")) {
        throw new Error("Thread mention popover not open");
      }
    });

    fireEvent.click(
      document.body.querySelector("button[aria-label='Copy thread UUID']") as HTMLButtonElement,
    );
    await settleAsyncRender();

    expect(writes.join(",")).toBe("019-thread");
  });
});
