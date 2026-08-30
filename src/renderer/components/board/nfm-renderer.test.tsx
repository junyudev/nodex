import { afterEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  createDateMentionClockStore,
  setDateMentionClockStoreForTest,
} from "@/lib/nfm/date-mention-clock";
import {
  renderWithMaitai as render,
  settleAsyncRender,
  textContent,
  waitForStreamdownCodeHighlight,
} from "../../test/dom";
import { NfmRenderer } from "./nfm-renderer";

let restoreDateMentionClockStore: (() => void) | null = null;

afterEach(() => {
  restoreDateMentionClockStore?.();
  restoreDateMentionClockStore = null;
});

function installDateMentionClock(start: string) {
  let currentNow = new Date(start);
  const store = createDateMentionClockStore({
    now: () => new Date(currentNow.getTime()),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  restoreDateMentionClockStore = setDateMentionClockStoreForTest(store);

  return {
    store,
    setNow: (value: string) => {
      currentNow = new Date(value);
    },
  };
}

describe("NfmRenderer", () => {
  test("renders owning Page UUIDs and Page mention URLs", async () => {
    const { container } = render(
      <NfmRenderer
        content={['<page uuid="019f-card" />', '<page-ref url="nodex://pages/019f-target" />'].join(
          "\n",
        )}
      />,
    );

    await settleAsyncRender();

    expect(textContent(container)).toContain("Page · 019f-card");
    expect(textContent(container)).toContain("Page Mention · nodex://pages/019f-target");
  });

  test("renders inline code with the shared inline-markdown span contract", async () => {
    const { container } = render(
      <NfmRenderer content={"Paragraph with `inline code` and **bold** text."} />,
    );

    await settleAsyncRender();

    const inlineCode = container.querySelector("span.inline-markdown");
    expect(Boolean(inlineCode)).toBe(true);
    expect(inlineCode?.textContent).toBe("inline code");
    expect(container.querySelector(".nfm-render code") === null).toBe(true);
  });

  test("marks heading inline code with the heading-inline-code scope", async () => {
    const { container } = render(<NfmRenderer content={"## Heading with `inline code`"} />);

    await settleAsyncRender();

    const heading = container.querySelector("h2");
    const inlineCode = heading?.querySelector("span.inline-markdown");
    expect(Boolean(inlineCode)).toBe(true);
    expect(inlineCode?.textContent).toBe("inline code");
  });

  test("renders code blocks through Streamdown's code block renderer", async () => {
    const { container } = render(<NfmRenderer content={"```ts\nconst answer = 42\n```"} />);
    await waitForStreamdownCodeHighlight(container);

    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container.querySelector('[data-language="tsx"]')).not.toBeNull();
    expect(container.querySelector('[data-streamdown="code-block-actions"]') === null).toBe(true);
    expect(
      container.querySelector(
        '[data-nfm-code-block-readonly-header][data-language-id="typescript"]',
      )?.textContent,
    ).toContain("TypeScript");
    expect(container.querySelector('[aria-label="Open block actions menu"]')).toBeNull();
    expect(textContent(container).includes("const")).toBe(true);
  });

  test("falls back to plain code rendering for unknown languages without custom shiki HTML", async () => {
    const { container } = render(<NfmRenderer content={"```madeuplang\nhello()\n```"} />);
    await settleAsyncRender();

    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container.querySelector('pre[style*="--shiki-dark-bg"]') === null).toBe(true);
    expect(textContent(container).includes("hello()")).toBe(true);
  });

  test("fails closed for unresolved relative file-like links without a project workspace", async () => {
    const { container } = render(
      <NodexTooltipProvider>
        <NfmRenderer content={"[spec](folder/abc/file)"} />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    const link = container.querySelector("a[href='folder/abc/file']");
    expect(Boolean(link)).toBe(true);
    expect(link?.getAttribute("aria-disabled")).toBe("true");
    expect(link?.hasAttribute("title")).toBe(false);

    fireEvent.focus(link as Element);
    await settleAsyncRender();
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
      "Cannot resolve relative file link without project workspace.",
    );
  });

  test("passes project workspace context to relative file-like links", async () => {
    const { container } = render(
      <NodexTooltipProvider>
        <NfmRenderer
          content={"[spec](folder/abc/file)"}
          projectWorkspacePath="/workspace/project"
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    const link = container.querySelector("button[data-file-reference='true']");
    expect(Boolean(link)).toBe(true);
    expect(link?.getAttribute("aria-disabled") === null).toBe(true);
    expect(link?.getAttribute("title") === null).toBe(true);
  });

  test("renders agent config chip model ids as readable labels", async () => {
    const { container } = render(
      <NfmRenderer content={'Use <agent-config model="gpt-5.5" reasoning="high" /> now.'} />,
    );

    await settleAsyncRender();

    expect(textContent(container).includes("GPT-5.5")).toBe(true);
    expect(textContent(container).includes("gpt-5.5 · high")).toBe(false);
    expect(container.querySelector('[data-nodex-logo-mark="monochrome"]')).not.toBeNull();
  });

  test("refreshes relative date mention labels while mounted", async () => {
    const clock = installDateMentionClock("2026-06-28T12:00:00");
    const { container } = render(
      <NfmRenderer
        content={'Plan around <mention-date start="2026-06-28" format="relative" />.'}
      />,
    );

    await settleAsyncRender();
    expect(textContent(container).includes("@Today")).toBe(true);

    await act(async () => {
      clock.setNow("2026-06-29T00:00:02");
      clock.store.refresh();
      await Promise.resolve();
    });

    expect(textContent(container).includes("@Yesterday")).toBe(true);
  });

  test("renders Page mentions as lightweight inline references", () => {
    const { container } = render(
      <NfmRenderer content={'See <mention-page url="nodex://pages/page-1" /> now.'} />,
    );

    expect(textContent(container).includes("page-1")).toBe(true);
    expect(container.querySelector('[href="nodex://pages/page-1"]')).toBeNull();
  });

  test("renders consecutive numbered list items in one ordered list with preserved numbering", async () => {
    const { container } = render(<NfmRenderer content={"1. first\n2. second\n3. third"} />);

    await settleAsyncRender();

    const orderedLists = Array.from(container.querySelectorAll("ol"));
    const listItems = Array.from(container.querySelectorAll("li"));

    expect(orderedLists.length).toBe(1);
    expect(orderedLists[0]?.getAttribute("start")).toBe("1");
    expect(listItems.length).toBe(3);
  });

  test("groups numbered lists by digit width and preserves ol start markers", async () => {
    const { container } = render(
      <NfmRenderer content={"99. Ninety-nine\n100. One hundred\n101. One hundred one"} />,
    );

    await settleAsyncRender();

    const orderedLists = Array.from(container.querySelectorAll("ol"));

    expect(orderedLists.length).toBe(2);
    expect(orderedLists[0]?.getAttribute("start")).toBe("99");
    expect(orderedLists[1]?.getAttribute("start")).toBe("100");
  });
});
