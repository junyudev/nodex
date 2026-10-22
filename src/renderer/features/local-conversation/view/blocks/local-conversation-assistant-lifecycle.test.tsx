import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import type { CodexConversationItem, CodexConversationTurn } from "@/lib/types";
import { buildTurnRenderModel } from "../../projection/build-turn-render-model";
import type { ThreadTranscriptBlockModel } from "../../thread-stage-types";
import { StrictMode } from "react";
import { settleLazyRender } from "@/test/dom";
import { ThreadBlockRenderer } from "./local-conversation-block-renderer";

vi.mock("../local-conversation-inline-visualization", async () => {
  const { useState } = await import("react");
  return {
    LocalConversationInlineVisualization: () => {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount((value) => value + 1)}>Widget count {count}</button>;
    },
  };
});

function assistantDocument(
  status: CodexConversationTurn["status"],
  source?: string,
): ThreadTranscriptBlockModel {
  const item: CodexConversationItem = {
    threadId: "thread",
    turnId: "turn",
    itemId: "assistant",
    entryId: "assistant",
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    assistantPhase: "final_answer",
    role: "assistant",
    status,
    markdownText: source ?? 'Stream baseline\n\n::codex-inline-vis{file="widget.html"}\n\n',
    createdAt: 1,
    updatedAt: 2,
  };
  const turn: CodexConversationTurn = {
    threadId: item.threadId,
    turnId: item.turnId,
    status,
    itemIds: [item.itemId],
    items: [item],
  };
  const model = buildTurnRenderModel({
    turn,
    requests: [],
    isLatestTurn: true,
    isStreamingTurn: status === "inProgress",
    canForkTurn: true,
  });
  const block = model.trailingBlocks.find((candidate) => candidate.type === "assistantMessage");
  if (!block || block.type !== "assistantMessage") throw new Error("Expected an assistant body");
  return block;
}

function Assistant({ block, live }: { block: ThreadTranscriptBlockModel; live: boolean }) {
  return (
    <NodexTooltipProvider>
      <ThreadBlockRenderer block={block} isLatestTurn isStreamingTurn={live} />
    </NodexTooltipProvider>
  );
}

describe("assistant document lifecycle", () => {
  test("whole-response and code-block Copy consume their distinct authored sources", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const payload =
      '【F:src/a%20b.ts†L2】 cite\n::unknown{x=y}\n:codex-followup[Go]{prompt="run"}';
    const source = `\`\`\`text\n${payload}\n\`\`\``;
    const mounted = render(
      <Assistant block={assistantDocument("completed", source)} live={false} />,
    );
    try {
      await settleLazyRender();
      const codeButton = mounted.container.querySelector<HTMLButtonElement>(
        "[data-nfm-code-block-readonly-header] button",
      )!;
      await act(async () => {
        fireEvent.click(codeButton);
        await Promise.resolve();
      });
      await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(payload));
      writeText.mockClear();
      await act(async () => {
        fireEvent.click(mounted.getByRole("button", { name: /^Copy$/ }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          '```text\nsrc/a b.ts:2 \n::unknown{x=y}\n:codex-followup[Go]{prompt="run"}\n```',
        ),
      );
      expect(writeText).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
  test("copies complete authored markup and blank lines through the ordinary action", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const source = '  **Hello**\n\n\n\n::unknown{file="report.html" title="X"}\n\nSecond  ';
    const mounted = render(
      <Assistant block={assistantDocument("completed", source)} live={false} />,
    );
    try {
      const button = await mounted.findByRole("button", { name: /^Copy$/ });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(source.trim()));
    } finally {
      mounted.unmount();
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test.each(["alpha\n\n\n\nbeta", "alpha\u2028beta\u2029gamma\u0085delta"])(
    "copies authored code through the actual assistant caller: %j",
    async (payload) => {
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const source = `\`\`\`text
${payload}
\`\`\``;
      const mounted = render(
        <StrictMode>
          <Assistant block={assistantDocument("inProgress", source)} live />
        </StrictMode>,
      );
      try {
        await settleLazyRender();
        const button = mounted.container.querySelector<HTMLButtonElement>(
          "[data-nfm-code-block-readonly-header] button",
        )!;
        await act(async () => {
          button.focus();
          fireEvent.click(button);
          await Promise.resolve();
        });
        await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(payload));
        mounted.rerender(
          <StrictMode>
            <Assistant block={assistantDocument("completed", source)} live={false} />
          </StrictMode>,
        );
        await settleLazyRender();
        expect(
          mounted.container.querySelector("[data-nfm-code-block-readonly-header] button"),
        ).toBe(button);
        expect(document.activeElement).toBe(button);
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
        });
        await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(payload));
        expect(writeText).toHaveBeenCalledTimes(1);
      } finally {
        mounted.unmount();
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    },
  );

  test("retains interactive state and focus when completion adds actions and output", async () => {
    const streaming = assistantDocument("inProgress");
    const completed = assistantDocument("completed");
    expect(streaming.assistantMessageActions).toBeUndefined();
    expect(completed.assistantMessageActions?.copyText).toBeTruthy();
    const mounted = render(<Assistant block={streaming} live />);
    const original = await mounted.findByRole("button", { name: "Widget count 0" });
    await act(async () => {
      fireEvent.click(original);
      original.focus();
    });
    await mounted.findByRole("button", { name: "Widget count 1" });

    mounted.rerender(<Assistant block={completed} live={false} />);
    await waitFor(() =>
      expect(mounted.getByRole("button", { name: "Widget count 1" })).toBe(original),
    );
    expect(document.activeElement).toBe(original);

    mounted.rerender(
      <Assistant
        live={false}
        block={{
          ...completed,
          assistantAfterBlocks: [
            {
              id: "output",
              turnId: "turn",
              createdAt: 1,
              updatedAt: 2,
              searchableText: "",
              type: "workedFor",
              status: "worked",
              startedAtMs: 1,
              completedAtMs: 2,
            },
          ],
        }}
      />,
    );
    await waitFor(() =>
      expect(mounted.getByRole("button", { name: "Widget count 1" })).toBe(original),
    );
    expect(document.activeElement).toBe(original);
  });
});
