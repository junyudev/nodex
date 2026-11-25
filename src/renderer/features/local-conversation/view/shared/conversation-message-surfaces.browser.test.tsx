import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, describe } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import type { ThreadAssistantMessageActionsModel } from "../../thread-stage-types";
import { AssistantMessageActionsRow } from "./assistant-message-actions";
import { formatThreadMessageTimestamp } from "./thread-message-timestamp";
import type { ReactElement } from "react";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { TestQueryProvider } from "@/test/query";
import "../../../../globals.css";
import { waitForCodeHighlight } from "../../../../test/dom";
import { MessageText } from "@/components/message/message-document";
import type { CodexTranscriptEntry } from "../../../../../shared/types";
import { ConversationRecoverySurface } from "./conversation-recovery-surface";

describe("assistant message actions", () => {
  installRendererThemeFixture();

  const sentAtMs = new Date(2026, 9, 28, 19, 46).getTime();

  function Reply({ text, alwaysVisible }: { text: string; alwaysVisible: boolean }) {
    const actions: ThreadAssistantMessageActionsModel = {
      copyText: text,
      sentAtMs,
      canFork: false,
      ...(alwaysVisible ? { alwaysVisible: true } : {}),
    };
    return (
      <div className="group flex min-w-0 flex-col" data-testid={text}>
        <p>{text}</p>
        <AssistantMessageActionsRow
          actions={actions}
          threadId="thread"
          turnId="turn"
          isLatestTurn
        />
      </div>
    );
  }

  /** How visible an element is, through every faded ancestor within its reply. */
  const shownOpacity = (element: Element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
      if (node.classList.contains("group")) break;
    }
    return opacity;
  };

  const within = (reply: string) => screen.getByTestId(reply);
  const copyIn = (reply: string) =>
    within(reply).querySelector("button[aria-label='Copy']") as HTMLElement;
  const timestampIn = (reply: string) =>
    [...within(reply).querySelectorAll("span")].find(
      (span) => span.textContent === formatThreadMessageTimestamp(sentAtMs),
    ) as HTMLElement;

  test("the latest reply keeps its actions in view while its timestamp waits for hover", async () => {
    render(
      <NodexTooltipProvider>
        <Reply text="Earlier reply" alwaysVisible={false} />
        <Reply text="Latest reply" alwaysVisible />
      </NodexTooltipProvider>,
    );

    expect(shownOpacity(copyIn("Latest reply"))).toBe(1);
    expect(shownOpacity(timestampIn("Latest reply"))).toBe(0);
    expect(shownOpacity(copyIn("Earlier reply"))).toBe(0);
    expect(shownOpacity(timestampIn("Earlier reply"))).toBe(0);

    await act(async () => {
      await userEvent.hover(screen.getByText("Latest reply"));
    });
    await expect.poll(() => shownOpacity(timestampIn("Latest reply"))).toBe(1);
    expect(shownOpacity(copyIn("Earlier reply"))).toBe(0);

    await act(async () => {
      await userEvent.hover(screen.getByText("Earlier reply"));
    });
    await expect.poll(() => shownOpacity(copyIn("Earlier reply"))).toBe(1);
    expect(shownOpacity(timestampIn("Earlier reply"))).toBe(1);
    expect(shownOpacity(timestampIn("Latest reply"))).toBe(0);
    expect(shownOpacity(copyIn("Latest reply"))).toBe(1);
  });
});

describe("user message collapse", () => {
  const render = (ui: ReactElement) => renderWithAppMaitai(ui, { wrapper: TestQueryProvider });

  describe("MessageText browser collapse", () => {
    test("measures real layout and removes clipped links from keyboard navigation", async () => {
      const message = Array.from(
        { length: 60 },
        (_value, index) => `[Reference ${index + 1}](https://example.test/${index + 1})`,
      ).join("\n");
      const view = render(
        <div style={{ width: 420 }}>
          <MessageText text={message} collapsedLineCount={5} />
        </div>,
      );

      const showMore = await view.findByRole("button", { name: "Show more" });
      const links = view.getAllByRole("link", { hidden: true });
      const clippedLink = links.at(-1);
      expect(clippedLink).toBeDefined();
      if (!clippedLink) throw new Error("Expected the final message link");

      await waitFor(() => {
        expect(clippedLink.getAttribute("aria-hidden")).toBe("true");
        expect(clippedLink.hasAttribute("inert")).toBe(true);
      });

      await act(async () => {
        fireEvent.click(showMore);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(view.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
          "true",
        );
        expect(clippedLink.getAttribute("aria-hidden")).toBeNull();
        expect(clippedLink.hasAttribute("inert")).toBe(false);
      });
    });
    test("reserves the final collapsed line for an ellipsis and keeps a crossing code block whole", async () => {
      const tick = String.fromCharCode(96);
      const fence = tick.repeat(3);
      const codeText = Array.from(
        { length: 12 },
        (_, index) => `const codeLine${index} = ${index};`,
      ).join("\n");
      const text =
        "Before code\n\n" +
        fence +
        "typescript\n" +
        codeText +
        "\n" +
        fence +
        "\n\n" +
        Array.from({ length: 30 }, (_, index) => `After code ${index}`).join("\n");
      const view = render(
        <div style={{ width: 420 }}>
          <MessageText text={text} collapsedLineCount={5} />
        </div>,
      );
      await waitForCodeHighlight(view.container);
      await view.findByRole("button", { name: "Show more" });
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      const code = view.container.querySelector<HTMLElement>("[data-readonly-code-block]");
      const clip = code?.closest(".codex-markdown-user")?.parentElement?.parentElement;
      if (!code || !clip) throw new Error("Expected a mounted code block and clipping viewport");
      await waitFor(() =>
        expect(code.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          clip.getBoundingClientRect().bottom + 1,
        ),
      );
      const ellipsis = clip.nextElementSibling as HTMLElement;
      expect(ellipsis.textContent).toBe("…");
      expect(ellipsis.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(clip.style.maxHeight).toBe(
        `${Math.ceil(code.getBoundingClientRect().bottom - clip.getBoundingClientRect().top)}px`,
      );
    });
  });
});

describe("conversation recovery surface", () => {
  installRendererThemeFixture();

  test("supports keyboard diagnostics without clipping the action in a narrow chat", async () => {
    await page.viewport(390, 330);
    const entry: CodexTranscriptEntry = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "error-1",
      type: "error",
      kind: "systemEvent",
      markdownText: "Request stream closed",
      additionalDetails: `Request ID: ${"0123456789abcdef".repeat(30)}`,
      recovery: {
        state: "failed",
        reason: "connection",
        attempt: 5,
        maxAttempts: 5,
        retryAt: null,
        updatedAt: null,
      },
      createdAt: 0,
      updatedAt: 0,
    };
    const view = render(
      <NodexTooltipProvider>
        <div style={{ width: 320, margin: 24 }}>
          <ConversationRecoverySurface entry={entry} isLatestTurn isStreamingTurn={false} />
        </div>
      </NodexTooltipProvider>,
    );
    const disclosure = view.getByRole("button", { name: "Connection could not be restored" });
    await act(async () => {
      disclosure.focus();
      await userEvent.keyboard("{Enter}");
    });
    const copy = await view.findByRole("button", { name: "Copy diagnostics" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      await userEvent.keyboard("{Tab}");
    });
    expect(document.activeElement).toBe(view.getByRole("region", { name: "Recovery diagnostics" }));
    await act(async () => {
      await userEvent.keyboard("{Tab}");
    });
    expect(document.activeElement).toBe(copy);
    const surface = view.container.firstElementChild as HTMLElement;
    expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
    expect(copy.getBoundingClientRect().right).toBeLessThanOrEqual(
      surface.getBoundingClientRect().right,
    );
    await act(async () => {
      await userEvent.keyboard("{Shift>}{Tab}{Tab}{/Shift}");
      await userEvent.keyboard(" ");
    });
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Copy diagnostics" })).toBeNull(),
    );
    expect(document.activeElement).toBe(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });
});
