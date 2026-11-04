import { render, waitFor } from "@testing-library/react";
import { getSharedHighlighter } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { sourceHighlightCacheKey } from "@/lib/source-highlight-cache";
import { getSourceHighlightPool } from "@/lib/source-highlight-pool";
import { WorkspacePierreEditor, type WorkspacePierreEditorProps } from "./workspace-pierre-editor";
import "@/globals.css";

vi.mock("@/lib/use-theme", () => ({ useTheme: () => ({ resolved: "light" }) }));
vi.mock("@/lib/use-code-font-size", () => ({ useCodeFontSize: () => ({ codeFontSize: 12 }) }));
installRendererThemeFixture();
afterEach(() => {
  vi.restoreAllMocks();
});

// Long enough that tokenizing it on the window thread would be a visible stall.
const source = Array.from(
  { length: 1_500 },
  (_, index) =>
    `<section id="s${index}"><style>.c${index} { color: red; }</style><script>const v${index} = ${index};</script></section>`,
).join("\n");
const file = {
  name: "page.html",
  contents: source,
  cacheKey: sourceHighlightCacheKey("local\0/repo/page.html", "html", source),
};

function HtmlEditor(props: Partial<WorkspacePierreEditorProps>) {
  return (
    <div style={{ width: 900, height: 350 }}>
      <WorkspacePierreEditor
        value={source}
        filename="page.html"
        language="html"
        sourceIdentity="/repo/page.html"
        file={{ hostId: "local", path: "/repo/page.html" }}
        documentVersion={0}
        ariaLabel="Source editor for page.html"
        onChange={() => {}}
        {...props}
      />
    </div>
  );
}

async function settle(assert: () => void) {
  return waitFor(assert, { timeout: 15_000 });
}

function expectHighlightedEditor(container: HTMLElement) {
  const root = container.querySelector("diffs-container")?.shadowRoot;
  expect(root?.querySelector("[data-line] span[style]")).toBeInstanceOf(HTMLElement);
  expect(root?.querySelector('[contenteditable="true"]')).toBeInstanceOf(HTMLElement);
}

/**
 * Watches the window thread's highlighter for grammar work; plain-text passes
 * (Pierre's placeholder rows) are expected and ignored.
 */
async function watchWindowThreadTokenizing() {
  const highlighter = await getSharedHighlighter({
    themes: ["pierre-light", "pierre-dark"],
    langs: ["html"],
  });
  const codeToTokens = vi.spyOn(Object.getPrototypeOf(highlighter), "codeToTokens");
  return () =>
    codeToTokens.mock.calls.filter(([, options]) => (options as { lang?: string }).lang !== "text");
}

/** Records, for each editor attachment, whether the pool already held this file's highlight. */
function recordEditorStarts() {
  const pool = getSourceHighlightPool();
  const starts: { readonly editor: Editor; readonly highlighted: boolean }[] = [];
  const edit = Editor.prototype.edit;
  vi.spyOn(Editor.prototype, "edit").mockImplementation(function (this: Editor, ...args) {
    starts.push({ editor: this, highlighted: pool?.getFileResultCache(file) != null });
    return edit.apply(this, args);
  });
  return starts;
}

describe("Files source highlighting", () => {
  test("highlights in a worker and edits from that highlight without tokenizing here", async () => {
    const tokenizing = await watchWindowThreadTokenizing();
    const starts = recordEditorStarts();
    const view = render(<HtmlEditor />);

    await settle(() => expectHighlightedEditor(view.container));
    expect(getSourceHighlightPool()?.getStats().workersFailed).toBe(false);
    expect(starts.map(({ highlighted }) => highlighted)).toEqual([true]);
    expect(tokenizing()).toEqual([]);
  });

  test("reopening unchanged content reuses the finished highlight", async () => {
    const first = render(<HtmlEditor />);
    await settle(() => expectHighlightedEditor(first.container));
    first.unmount();

    const tokenizing = await watchWindowThreadTokenizing();
    const starts = recordEditorStarts();
    const workerRequests = vi.spyOn(Worker.prototype, "postMessage");
    const second = render(<HtmlEditor />);

    await settle(() => expectHighlightedEditor(second.container));
    expect(starts.map(({ highlighted }) => highlighted)).toEqual([true]);
    expect(
      workerRequests.mock.calls.filter(
        ([message]) => (message as { type?: string }).type === "file",
      ),
    ).toEqual([]);
    expect(tokenizing()).toEqual([]);
  });

  test("a reveal places the caret once editing starts", async () => {
    const starts = recordEditorStarts();
    const onRevealComplete = vi.fn();
    // Like the Files panel, the request clears once the editor reports it complete.
    function RevealingEditor() {
      const [reveal, setReveal] = useState<WorkspacePierreEditorProps["revealLocation"]>({
        line: 40,
        column: 3,
      });
      return (
        <HtmlEditor
          // Content of its own, so the reveal lands while the view waits for a worker.
          value={`${source}\n<!-- reveal -->`}
          revealLocation={reveal}
          onRevealComplete={(location) => {
            onRevealComplete(location);
            setReveal(undefined);
          }}
        />
      );
    }
    const view = render(<RevealingEditor />);

    await settle(() => {
      expectHighlightedEditor(view.container);
      expect(onRevealComplete).toHaveBeenCalledTimes(1);
    });
    const caret = starts.at(-1)?.editor.getViewState().selections?.at(-1);
    expect(caret?.start).toEqual({ line: 39, character: 2 });
  });
});
