import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  createDateMentionClockStore,
  setDateMentionClockStoreForTest,
} from "@/lib/editor-model/date-mention-clock";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { settleAsyncRender, textContent } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { NfmDocument } from "./nfm-renderer";
import { readMarkdown } from "../../../shared/nodex-markdown";

const mentionTarget = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/block-reference-queries", () => ({
  usePageTargetReadModel: () => ({ data: mentionTarget.current, loading: false, error: null }),
  useDatabaseViewReadModel: () => ({ data: null, loading: false, error: null }),
}));
vi.mock("@/lib/content-page-detail", () => ({
  useContentPageDetail: () => ({ detail: null, loading: false, error: null }),
}));

/** Nodex Markdown read and shown as a Page lays it out. */
function NfmRenderer({
  content,
  projectWorkspacePath,
}: {
  readonly content: string;
  readonly projectWorkspacePath?: string;
}) {
  return <NfmDocument blocks={readMarkdown(content)} projectWorkspacePath={projectWorkspacePath} />;
}

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
  test("renders pinned and content-sized columns with NFM cell attributes", async () => {
    const { findByRole } = render(
      <NfmDocument
        blocks={[
          {
            type: "table",
            content: {
              type: "tableContent",
              columnWidths: [120, undefined],
              headerCols: 1,
              rows: [
                {
                  cells: [
                    { content: [{ type: "text", text: "Pinned" }] },
                    {
                      content: [
                        {
                          type: "link",
                          content: [{ type: "text", text: "A long label inside a link" }],
                        },
                      ],
                      props: { backgroundColor: "blue", textColor: "red", textAlignment: "right" },
                    },
                  ],
                },
              ],
            },
          },
        ]}
      />,
    );

    const table = (await findByRole("table")) as HTMLTableElement;
    const [pinned, auto] = table.querySelectorAll("col");
    expect(table.dataset.nfmTableLayout).toBe("mixed");
    expect(pinned.style.width).toBe("120px");
    expect(auto.style.width).toBe("");
    const [header, data] = table.rows[0].cells;
    expect(header.tagName).toBe("TH");
    expect(header.dataset.nfmCellFit).toBeUndefined();
    expect(data.dataset.nfmCellFit).toBe("long");
    expect(data.dataset.backgroundColor).toBe("blue");
    expect(data.dataset.textColor).toBe("red");
    expect(data.style.textAlign).toBe("right");
  });

  test("shows subpages and Page references as references, never as identities", async () => {
    mentionTarget.current = {
      status: "available",
      page: { title: "Launch plan", preview: "", lifecycle: "active" },
    };
    const { container } = render(
      <NfmRenderer content={'::page{id="019f-card"}\n\n::page-ref{page="019f-target"}'} />,
    );

    await settleAsyncRender();

    const references = container.querySelectorAll('[data-nodex-reference="page"]');
    expect(references).toHaveLength(2);
    expect(textContent(container)).toBe("Launch planLaunch plan");
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

  test("renders code blocks through the shared read-only code block", async () => {
    const { container } = render(<NfmRenderer content={"```ts\nconst answer = 42\n```"} />);
    await waitFor(() =>
      expect(container.querySelector("[data-readonly-code-block] code")).not.toBeNull(),
    );

    expect(
      container.querySelector('[data-readonly-code-block][data-language="typescript"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-nfm-code-block-readonly-header][data-language-id="typescript"]',
      )?.textContent,
    ).toContain("TypeScript");
    expect(container.querySelector('[aria-label="Open block actions menu"]')).toBeNull();
    expect(textContent(container).includes("const")).toBe(true);
  });

  test("presents unknown languages as catalog plain text", async () => {
    const { container } = render(<NfmRenderer content={"```madeuplang\nhello()\n```"} />);
    await settleAsyncRender();

    expect(
      container.querySelector('[data-readonly-code-block][data-language="text"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-nfm-code-block-readonly-header]")?.textContent).toContain(
      "Plain Text",
    );
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

  test("names a GitHub thread a link spells out, and keeps a worded link's words", async () => {
    const pull = "https://github.com/acme/app/pull/7";
    const { container } = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmRenderer
            content={`[${pull}](${pull}) and [the fix](https://github.com/acme/app/issues/8)`}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );

    await settleAsyncRender();

    expect(container.querySelector('[data-github-thread-link="mention"]')?.textContent).toBe(
      "acme/app#7",
    );
    expect(container.querySelector('[data-github-thread-link="link"]')?.textContent).toBe(
      "the fix",
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
      <NfmRenderer content={'Use :agent-config{model="gpt-5.5" reasoning="high"} now&#46;'} />,
    );

    await settleAsyncRender();

    expect(textContent(container).includes("GPT-5.5")).toBe(true);
    expect(textContent(container).includes("gpt-5.5 · high")).toBe(false);
    expect(container.querySelector('[data-nodex-logo-mark="monochrome"]')).not.toBeNull();
  });

  test("refreshes relative date mention labels while mounted", async () => {
    const clock = installDateMentionClock("2026-06-28T12:00:00");
    const { container } = render(
      <NfmRenderer content={'Plan around :date{start="2026-06-28" format="relative"}.'} />,
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

  test("names a mentioned Page without showing its identity", () => {
    mentionTarget.current = {
      status: "available",
      page: { title: "Launch plan", preview: "", lifecycle: "active" },
    };
    const { container } = render(<NfmRenderer content={"See <nodex://pages/page-1> now."} />);

    expect(textContent(container)).toContain("Launch plan");
    expect(textContent(container)).not.toContain("page-1");
  });

  test("names what became of a Page it cannot show", () => {
    mentionTarget.current = { status: "deleted", targetPageId: "page-1" };
    const { container } = render(<NfmRenderer content={"See <nodex://pages/page-1> now."} />);

    expect(textContent(container)).toContain("Deleted Page");
    expect(textContent(container)).not.toContain("page-1");
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

  test("shows images within text in place, opening their link or a full-size preview", async () => {
    const view = render(
      <NfmRenderer
        content={
          "Status [![build|16](https://ci.example/badge.svg)](https://ci.example) and " +
          "![diagram](https://example.com/diagram.png) and ![missing](nodex://files/file-1)"
        }
      />,
      { wrapper: TestQueryProvider },
    );

    await settleAsyncRender();

    const paragraph = view.container.querySelector("p");
    const badge = view.getByAltText("build");
    expect(paragraph?.contains(badge)).toBe(true);
    expect(badge.closest("a")?.getAttribute("href")).toBe("https://ci.example");
    expect((badge as HTMLImageElement).style.maxWidth).toBe("16px");
    // A Library File without a File runtime cannot display; its description stands in.
    expect(view.queryByAltText("missing")).toBeNull();
    expect(textContent(view.container)).toContain("missing");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Open diagram" }));
      await Promise.resolve();
    });
    expect(await view.findByRole("dialog", { name: "Image preview" })).toBeTruthy();
  });
});
