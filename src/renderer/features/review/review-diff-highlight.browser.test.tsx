import { getSharedHighlighter, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { FileDiff as ReviewFileDiff } from "@/components/workbench/review-diff-panel-deps";
import { InlineFileDiff } from "@/features/local-conversation/view/shared/tools/inline-file-diff";
import {
  getNodexDiffHostStyle,
  getNodexDiffOptions,
  getNodexReviewDiffOptions,
} from "@/lib/diff-presentation";
import { diffHighlightCacheKey } from "@/lib/diff-highlight-cache";
import { getWordDiffHighlightPool } from "@/lib/diff-highlight-pool";
import { getSourceHighlightPool } from "@/lib/source-highlight-pool";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import "@/globals.css";

installRendererThemeFixture();
afterEach(() => vi.restoreAllMocks());
const source = Array.from(
  { length: 1_500 },
  (_, i) =>
    `<section id="s${i}"><style>.c${i} { color: red; }</style><script>const v${i} = ${i};</script></section>`,
).join("\n");
const diff = parseDiffFromFile(
  { name: "page.html", contents: source },
  { name: "page.html", contents: source.replace("color: red", "color: blue") },
);
const reviewOptions = getNodexReviewDiffOptions("light", true, { diffStyle: "unified" });

async function settle(assert: () => void) {
  const deadline = performance.now() + 15_000;
  for (;;) {
    try {
      assert();
      return;
    } catch (error) {
      if (performance.now() > deadline) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}
function highlighted(container: HTMLElement) {
  const root = container.querySelector("diffs-container")?.shadowRoot;
  expect(root?.querySelector("[data-line] span[style]")).toBeInstanceOf(HTMLElement);
  return root;
}
async function watchWindowThreadTokenizing() {
  const highlighter = await getSharedHighlighter({
    themes: ["pierre-light", "pierre-dark"],
    langs: ["html"],
  });
  const spy = vi.spyOn(Object.getPrototypeOf(highlighter), "codeToTokens");
  return () =>
    spy.mock.calls.filter(([, options]) => (options as { lang?: string }).lang !== "text");
}
function diffRequests(spy: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return spy.mock.calls.filter(([message]) => (message as { type?: string }).type === "diff");
}
function Review({
  wordDiffs = true,
  fileDiff = diff,
}: {
  wordDiffs?: boolean;
  fileDiff?: typeof diff;
}) {
  return (
    <ReviewFileDiff
      fileDiff={fileDiff}
      options={{ ...reviewOptions, lineDiffType: wordDiffs ? "word-alt" : "none" }}
    />
  );
}

describe("Review diff highlighting", () => {
  test("colors a large Review diff in workers and reuses it after unmount", async () => {
    const tokenizing = await watchWindowThreadTokenizing();
    const first = render(<Review />);
    await settle(() => {
      const root = highlighted(first.container);
      expect(root?.querySelector("[data-diff-span]")).toBeInstanceOf(HTMLElement);
    });
    first.unmount();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    const second = render(<Review />);
    await settle(() => highlighted(second.container));
    expect(getWordDiffHighlightPool()?.getStats().workersFailed).toBe(false);
    expect(diffRequests(requests)).toEqual([]);
    expect(tokenizing()).toEqual([]);
  });

  test("finishes in-flight colors after a row unmounts and reuses them on return", async () => {
    const pending = { ...diff, name: "in-flight.html" };
    const cached = { ...pending, cacheKey: `${diffHighlightCacheKey(pending)}\0` };
    const pool = getWordDiffHighlightPool();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    const first = render(<Review fileDiff={pending} />);
    await settle(() => expect(diffRequests(requests).length).toBeGreaterThan(0));
    first.unmount();
    await settle(() => expect(pool?.getDiffResultCache(cached)).toBeDefined());
    requests.mockClear();
    const second = render(<Review fileDiff={pending} />);
    await settle(() => highlighted(second.container));
    expect(diffRequests(requests)).toEqual([]);
  });

  test("switching word diffs selects a separate pool and preserves both finished results", async () => {
    const tokenizing = await watchWindowThreadTokenizing();
    const view = render(<Review />);
    await settle(() =>
      expect(highlighted(view.container)?.querySelector("[data-diff-span]")).toBeInstanceOf(
        HTMLElement,
      ),
    );
    view.rerender(<Review wordDiffs={false} />);
    await settle(() => {
      expect(highlighted(view.container)?.querySelector("[data-diff-span]")).toBeNull();
      expect(getSourceHighlightPool()?.getStats().diffCacheSize).toBeGreaterThan(0);
    });
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    view.rerender(<Review />);
    await settle(() =>
      expect(highlighted(view.container)?.querySelector("[data-diff-span]")).toBeInstanceOf(
        HTMLElement,
      ),
    );
    expect(diffRequests(requests)).toEqual([]);
    expect(tokenizing()).toEqual([]);
  });

  test("full contents replace the partial AST even when a producer reuses its key", async () => {
    const partial = parsePatchFiles(
      "--- a/page.html\n+++ b/page.html\n@@ -1 +1 @@\n-<p>old</p>\n+<p>new</p>\n",
    )[0]?.files[0];
    if (!partial) throw new Error("Expected a partial fixture");
    const view = render(<Review fileDiff={{ ...partial, cacheKey: "same-producer-key" }} />);
    await settle(() => highlighted(view.container));
    const tokenizing = await watchWindowThreadTokenizing();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    const hydrated = { ...diff, cacheKey: "same-producer-key", name: "hydrated.html" };
    view.rerender(<Review fileDiff={hydrated} />);
    await settle(() => {
      highlighted(view.container);
      expect(diffRequests(requests).length).toBeGreaterThan(0);
      expect(view.container.querySelector("diffs-container")?.shadowRoot?.textContent).toContain(
        'id="s0"',
      );
    });
    expect(tokenizing()).toEqual([]);
  });

  test("a failed pool keeps large diffs plain on the window thread", async () => {
    const pool = getWordDiffHighlightPool();
    if (!pool) throw new Error("Expected a browser worker pool");
    vi.spyOn(pool, "isWorkingPool").mockReturnValue(false);
    const tokenizing = await watchWindowThreadTokenizing();
    const view = render(<Review fileDiff={{ ...diff, name: "unavailable.html" }} />);
    await settle(() => {
      const root = view.container.querySelector("diffs-container")?.shadowRoot;
      expect(root?.querySelector("[data-content] > [data-line]")).toBeInstanceOf(HTMLElement);
    });
    expect(tokenizing()).toEqual([]);
  });

  test("chat inline diffs share the line-only pool and its remount cache", async () => {
    const tokenizing = await watchWindowThreadTokenizing();
    const inline = (
      <InlineFileDiff
        fileDiff={diff}
        className="nodex-inline-diff"
        style={getNodexDiffHostStyle("light")}
        options={getNodexDiffOptions("light", true)}
      />
    );
    const first = render(inline);
    await settle(() => highlighted(first.container));
    first.unmount();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    const second = render(inline);
    await settle(() => highlighted(second.container));
    expect(diffRequests(requests)).toEqual([]);
    expect(tokenizing()).toEqual([]);
  });
});
