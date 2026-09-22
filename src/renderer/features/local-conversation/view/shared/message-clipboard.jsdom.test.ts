import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  getMessageCopyHtml,
  normalizeMessageCopyText,
  writeMessageToClipboard,
} from "./message-clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("message clipboard", () => {
  test("normalizes displayed citations and annotations while preserving code examples", () => {
    expect(
      normalizeMessageCopyText(
        'See 【F:src/a%20b.ts†L2-L4】 citeturn1 :codex-annotation{index="2"}\n\n::note{value="hidden"}\n\n`【F:src/a.ts†L1】`\n\n```text\n::note{value="keep"}\n```',
      ),
    ).toBe(
      'See src/a b.ts:2-4  Annotation 2\n\n`【F:src/a.ts†L1】`\n\n```text\n::note{value="keep"}\n```',
    );
  });

  test("compacts prose gaps without changing blank lines inside code blocks", () => {
    const code = "```text\nfirst\n\n\nlast\n```";
    expect(
      normalizeMessageCopyText(`Before.\n\n::note{value="hidden"}\n\n${code}\n\n\nAfter.`),
    ).toBe(`Before.\n\n${code}\n\nAfter.`);
  });

  test("copies semantic formatting and portable file links without toolbar chrome", () => {
    document.body.innerHTML =
      '<section data-message-copy-root><div class="codex-markdown"><h2>Title</h2><p><strong>Bold</strong> <button data-prompt-link-href="/repo/a.ts:4" data-prompt-link-label="a.ts">icon a.ts</button></p><pre><code>const a = 1;</code></pre><button>Copy code</button><script>bad()</script></div><button id="copy">Copy response</button></section>';
    expect(getMessageCopyHtml(document.querySelector("#copy")!)).toBe(
      '<h2>Title</h2><p><strong>Bold</strong> <a href="/repo/a.ts:4">a.ts</a></p><pre><code>const a = 1;</code></pre>',
    );
  });

  test("uses the local body when the same turn is mounted in another surface", () => {
    document.body.innerHTML =
      '<section><div data-message-copy-root="same"><div class="codex-markdown"><p>Earlier render</p></div></div></section><section><div data-message-copy-root="same"><div class="codex-markdown"><p>Current render</p></div></div><div data-message-copy-source="same"><button id="copy">Copy</button></div></section>';
    expect(getMessageCopyHtml(document.querySelector("#copy")!)).toBe("<p>Current render</p>");
  });

  test("does not borrow a preview when this turn's body is unmounted", () => {
    document.body.innerHTML =
      '<section data-right-panel-latest-turn-preview><div data-message-copy-root="same"><div class="codex-markdown"><p>Preview</p></div></div></section><section data-content-search-turn-key="turn"><div data-message-copy-source="same"><button id="copy">Copy</button></div></section>';
    expect(getMessageCopyHtml(document.querySelector("#copy")!)).toBeNull();
  });

  test("does not attach unrelated tool markdown to a plain command copy", () => {
    document.body.innerHTML =
      '<section data-content-search-unit-key="tool"><div class="codex-markdown"><p>Tool explanation</p></div><button id="copy">Copy command</button></section>';
    expect(getMessageCopyHtml(document.querySelector("#copy")!)).toBeNull();
  });

  test("writes both representations and falls back to plain text on rich-copy failure", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    expect(await writeMessageToClipboard("**Bold**", "<strong>Bold</strong>")).toBe(true);
    const item = write.mock.calls[0]?.[0][0];
    expect(Object.keys(item.data)).toEqual(["text/plain", "text/html"]);
    expect(writeText).not.toHaveBeenCalled();
    write.mockRejectedValueOnce(new Error("Unsupported"));
    expect(await writeMessageToClipboard("**Bold**", "<strong>Bold</strong>")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("**Bold**");
  });
});
