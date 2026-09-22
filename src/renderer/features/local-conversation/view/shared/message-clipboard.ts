import { writeTextToClipboard } from "@/lib/clipboard";
export { normalizeMessageCopyText } from "../../message-copy-text";

const COPY_ELEMENTS = new Set(
  "p br h1 h2 h3 h4 h5 h6 strong b em i s del blockquote ul ol li pre code table thead tbody tr th td hr a img sub sup".split(
    " ",
  ),
);
const OMIT_ELEMENTS = new Set(["script", "style", "svg", "button", "input", "textarea"]);

function copyNode(node: Node, output: HTMLElement): void {
  if (node.nodeType === Node.TEXT_NODE) {
    output.append(document.createTextNode(node.textContent ?? ""));
    return;
  }
  if (!(node instanceof Element)) return;
  const tag = node.tagName.toLowerCase();
  if (node.getAttribute("data-streamdown") === "code-block") {
    const source = node.querySelector("code");
    if (!source) return;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const lines = Array.from(source.querySelectorAll(":scope > span"));
    code.textContent =
      lines.length === 0
        ? source.textContent
        : lines.map((line) => (line.textContent ?? "").replace(/\n$/, "")).join("\n");
    pre.append(code);
    output.append(pre);
    return;
  }
  // File references render as interactive buttons; copy their portable label/link.
  const fileHref = node.getAttribute("data-prompt-link-href");
  if (fileHref) {
    const link = document.createElement("a");
    link.setAttribute("href", fileHref);
    link.textContent = node.getAttribute("data-prompt-link-label") ?? node.textContent;
    output.append(link);
    return;
  }
  if (OMIT_ELEMENTS.has(tag) || node.getAttribute("aria-hidden") === "true") return;
  const target = COPY_ELEMENTS.has(tag) ? document.createElement(tag) : output;
  for (const name of ["href", "src", "alt", "title", "start", "colspan", "rowspan"]) {
    const value = node.getAttribute(name);
    if (value === null || /^(?:javascript|vbscript):/i.test(value.trim())) continue;
    target.setAttribute(name, value);
  }
  node.childNodes.forEach((child) => copyNode(child, target));
  if (target !== output) output.append(target);
}

/** Read only the message body, excluding toolbars and other conversation chrome. */
export function getMessageCopyHtml(trigger: Element): string | null {
  const sourceId = trigger
    .closest("[data-message-copy-source]")
    ?.getAttribute("data-message-copy-source");
  // A reply can also be mounted in another surface. Never borrow that surface's
  // body when this turn's body is collapsed or unmounted; plain text is safer.
  const sourceScope =
    trigger.closest("[data-content-search-turn-key], [data-right-panel-latest-turn-preview]") ??
    trigger.closest("[data-message-copy-source]")?.parentElement;
  const sourceRoot =
    sourceId && sourceScope
      ? Array.from(sourceScope.querySelectorAll("[data-message-copy-root]")).find(
          (candidate) => candidate.getAttribute("data-message-copy-root") === sourceId,
        )
      : undefined;
  const root = sourceRoot ?? trigger.closest("[data-message-copy-root]");
  const markdown = root?.querySelector(".codex-markdown");
  if (!markdown) return null;
  const output = document.createElement("div");
  markdown.childNodes.forEach((node) => copyNode(node, output));
  return output.innerHTML || null;
}

export async function writeMessageToClipboard(
  text: string,
  html?: string | null,
): Promise<boolean> {
  if (
    html &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {
      // Plain text remains useful when the host rejects rich clipboard writes.
    }
  }
  return writeTextToClipboard(text);
}
