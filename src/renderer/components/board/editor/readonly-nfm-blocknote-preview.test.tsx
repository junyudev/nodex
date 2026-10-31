import { afterEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  createDateMentionClockStore,
  setDateMentionClockStoreForTest,
} from "@/lib/editor-model/date-mention-clock";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { settleAsyncRender, textContent } from "../../../test/dom";
import { TestQueryProvider } from "../../../test/query";
import { ReadonlyMarkdownBlockNotePreview } from "./readonly-nfm-blocknote-preview";

let restoreDateMentionClockStore: (() => void) | null = null;

afterEach(() => {
  restoreDateMentionClockStore?.();
  restoreDateMentionClockStore = null;

  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("toggle-")) keys.push(key);
  }
  for (const key of keys) {
    localStorage.removeItem(key);
  }
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

describe("readonly NFM BlockNote preview", () => {
  test("shows an image within text in place and keeps an image alone on its line a Block", async () => {
    const view = render(
      <TestQueryProvider>
        <ReadonlyMarkdownBlockNotePreview
          content={
            "Logo ![mark|20](https://example.com/mark.svg) here\n\n![Photo](https://example.com/photo.png)"
          }
          projectId="alpha"
          pageId="card-images"
          historyId={0}
        />
      </TestQueryProvider>,
    );

    const mark = await view.findByAltText("mark");
    expect(mark.closest("[data-content-type='paragraph']")).not.toBeNull();
    expect((mark as HTMLImageElement).style.maxWidth).toBe("20px");
    expect(view.container.querySelector("[data-content-type='image']")).not.toBeNull();
  });

  test("shows only the shared language label and Copy for Code Blocks", async () => {
    const view = render(
      <ReadonlyMarkdownBlockNotePreview
        content={"```ts\nconst answer = 42\n```"}
        projectId="alpha"
        pageId="card-code"
        historyId={0}
      />,
    );

    await waitFor(() => {
      expect(view.container.querySelector("[data-nfm-code-block-readonly-header]")).not.toBeNull();
    });
    expect(
      view.container.querySelector("[data-nfm-code-block-readonly-header]")?.textContent,
    ).toContain("TypeScript");
    expect(
      view.container.querySelector<HTMLElement>("[data-nfm-code-block-surface]")?.dataset.wrapped,
    ).toBe("false");
    expect(view.getByRole("button", { name: "Copy code to clipboard" })).not.toBeNull();
    expect(view.queryByRole("button", { name: "Open block actions menu" })).toBeNull();
    expect(view.queryByText("Wrap code")).toBeNull();
  });

  test("renders NFM content through the read-only BlockNote surface", async () => {
    const view = render(
      <ReadonlyMarkdownBlockNotePreview
        content={"# Historical heading\n\nSnapshot body with **bold** text"}
        projectId="alpha"
        pageId="card-1"
        historyId={1}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("Historical heading")) {
        throw new Error("Heading not rendered");
      }
    });

    expect(textContent(view.container).includes("Snapshot body")).toBe(true);
    expect(
      view.container.querySelector('[data-testid="readonly-nfm-blocknote-preview"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[contenteditable="true"]') === null).toBe(true);
  });

  test("renders live embeds as inert placeholders", async () => {
    const view = render(
      <ReadonlyMarkdownBlockNotePreview
        content={'::page-ref{page="card-1"}\n\n::database-view-ref{view="view-1" hint="Planning"}'}
        projectId="alpha"
        pageId="card-1"
        historyId={2}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("Page reference")) {
        throw new Error("Page reference placeholder not rendered");
      }
    });

    const body = textContent(view.container);
    expect(body.includes("Database view")).toBe(true);
    expect(body.includes("Search Pages")).toBe(false);
    expect(body.includes("Rules")).toBe(false);
  });

  test("renders attachment, agent config, and thread mention as inert inline content", async () => {
    const view = render(
      <ReadonlyMarkdownBlockNotePreview
        content={
          'Before :attachment{kind="file" mode="link" source="/tmp/report.md" name="report.md"} after\n\nUse :agent-config{mode="plan" model="gpt-5.5" reasoning="high"}\n\nSee <nodex://sessions/019-thread>'
        }
        projectId="alpha"
        pageId="card-1"
        historyId={3}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("report.md")) {
        throw new Error("Attachment chip not rendered");
      }
    });

    const attachmentChip = Array.from(view.container.querySelectorAll("span")).find((element) =>
      textContent(element).includes("report.md"),
    );
    expect(attachmentChip).not.toBeNull();
    if (!attachmentChip) return;
    expect(attachmentChip.querySelector('[data-file-tab-icon="document"]')).not.toBeNull();

    fireEvent.click(attachmentChip);
    fireEvent.click(view.getByText("Agent config"));
    await settleAsyncRender();

    expect(textContent(view.container).includes("Agent config")).toBe(true);
    expect(textContent(view.container).includes("019-thread")).toBe(true);
    expect(document.body.querySelector('[role="dialog"]') === null).toBe(true);
    expect(document.body.querySelector('[data-slot="popover-content"]') === null).toBe(true);
  });

  test("refreshes readonly date mention labels while mounted", async () => {
    const clock = installDateMentionClock("2026-06-28T12:00:00");
    const view = render(
      <ReadonlyMarkdownBlockNotePreview
        content={'Readonly note with :date{start="2026-06-28" format="relative"}.'}
        projectId="alpha"
        pageId="card-1"
        historyId={5}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("@Today")) {
        throw new Error("Date mention did not render as Today");
      }
    });

    await act(async () => {
      clock.setNow("2026-06-29T00:00:02");
      clock.store.refresh();
      await Promise.resolve();
    });

    await waitFor(() => {
      if (!textContent(view.container).includes("@Yesterday")) {
        throw new Error("Date mention did not refresh to Yesterday");
      }
    });
  });
});
