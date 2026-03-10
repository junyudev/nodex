import type { NfmInlineContent, NfmStyleSet, NfmColor } from "./types";
import { NFM_COLORS } from "./types";
import { getXmlAttr } from "./xml-attributes";

/**
 * Parse a string of NFM inline content into structured NfmInlineContent[].
 * Handles: **bold**, *italic*, ~~strike~~, `code`, [link](url),
 * <span underline="true">text</span>, <span color="Color">text</span>, <br>
 * Backslash escaping for: \ * ~ ` $ [ ] < > { } | ^
 */
export function parseInlineContent(input: string): NfmInlineContent[] {
  if (!input) return [];
  let i = 0;
  const len = input.length;

  function parseRun(styles: NfmStyleSet, terminators: string[]): NfmInlineContent[] {
    const items: NfmInlineContent[] = [];
    let textBuf = "";

    function flushText() {
      if (textBuf) {
        items.push({ type: "text", text: textBuf, styles: { ...styles } });
        textBuf = "";
      }
    }

    while (i < len) {
      // Check terminators
      for (const t of terminators) {
        if (input.startsWith(t, i)) return (flushText(), items);
      }

      // Backslash escape
      if (input[i] === "\\" && i + 1 < len && isEscapable(input[i + 1])) {
        textBuf += input[i + 1];
        i += 2;
        continue;
      }

      // <br> line break
      if (input.startsWith("<br>", i)) {
        flushText();
        items.push({ type: "linebreak" });
        i += 4;
        continue;
      }

      if (input.startsWith("<attachment", i)) {
        const attachment = tryParseAttachment();
        if (attachment) {
          flushText();
          items.push(attachment);
          continue;
        }
      }

      // <span underline="true"> or <span color="Color">
      if (input.startsWith("<span ", i)) {
        const spanResult = tryParseSpan(styles);
        if (spanResult) {
          flushText();
          items.push(...spanResult);
          continue;
        }
      }

      // Inline code: `code`
      if (input[i] === "`" && !styles.code) {
        const end = input.indexOf("`", i + 1);
        if (end !== -1) {
          flushText();
          const codeText = input.slice(i + 1, end);
          items.push({ type: "text", text: codeText, styles: { ...styles, code: true } });
          i = end + 1;
          continue;
        }
      }

      // Bold: **text**
      if (input.startsWith("**", i) && !styles.bold) {
        flushText();
        i += 2;
        const inner = parseRun({ ...styles, bold: true }, ["**"]);
        items.push(...inner);
        if (input.startsWith("**", i)) i += 2;
        continue;
      }

      // Strikethrough: ~~text~~
      if (input.startsWith("~~", i) && !styles.strikethrough) {
        flushText();
        i += 2;
        const inner = parseRun({ ...styles, strikethrough: true }, ["~~"]);
        items.push(...inner);
        if (input.startsWith("~~", i)) i += 2;
        continue;
      }

      // Italic: *text* (single *, not **)
      if (input[i] === "*" && input[i + 1] !== "*" && !styles.italic) {
        flushText();
        i += 1;
        const inner = parseRun({ ...styles, italic: true }, ["*"]);
        items.push(...inner);
        if (i < len && input[i] === "*") i += 1;
        continue;
      }

      // Link: [text](url)
      if (input[i] === "[") {
        const linkResult = tryParseLink(styles);
        if (linkResult) {
          flushText();
          items.push(linkResult);
          continue;
        }
      }

      textBuf += input[i];
      i++;
    }

    flushText();
    return items;
  }

  function tryParseLink(styles: NfmStyleSet): NfmInlineContent | null {
    if (input[i] !== "[") return null;

    // Find closing ]
    let depth = 0;
    let j = i + 1;
    while (j < len) {
      if (input[j] === "\\" && j + 1 < len) { j += 2; continue; }
      if (input[j] === "[") depth++;
      if (input[j] === "]") {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (j >= len) return null;

    const rawText = input.slice(i + 1, j);
    const text = unescapeNfm(rawText);

    // Expect ( immediately after ]
    if (j + 1 >= len || input[j + 1] !== "(") return null;

    // Find closing )
    const urlStart = j + 2;
    let urlEnd = urlStart;
    let parenDepth = 0;
    while (urlEnd < len) {
      if (input[urlEnd] === "(") parenDepth++;
      if (input[urlEnd] === ")") {
        if (parenDepth === 0) break;
        parenDepth--;
      }
      urlEnd++;
    }
    if (urlEnd >= len) return null;

    const href = input.slice(urlStart, urlEnd);
    i = urlEnd + 1;
    return { type: "link", text, href, styles: { ...styles } };
  }

  function tryParseSpan(styles: NfmStyleSet): NfmInlineContent[] | null {
    // Match <span underline="true"> or <span color="..."> or <span color?="...">
    const spanOpenRe = /^<span\s+(underline="true"|color\??="([^"]*)")>/;
    const match = input.slice(i).match(spanOpenRe);
    if (!match) return null;

    const fullMatch = match[0];
    const isUnderline = match[1] === 'underline="true"';
    const colorValue = match[2] as NfmColor | undefined;

    // Find closing </span>
    const afterOpen = i + fullMatch.length;
    const closeTag = "</span>";
    const closeIdx = input.indexOf(closeTag, afterOpen);
    if (closeIdx === -1) return null;

    // Parse inner content recursively with updated styles
    i = afterOpen;
    const newStyles: NfmStyleSet = { ...styles };
    if (isUnderline) newStyles.underline = true;
    if (colorValue && NFM_COLORS.includes(colorValue as NfmColor)) {
      newStyles.color = colorValue as NfmColor;
    }

    const inner = parseRun(newStyles, ["</span>"]);
    if (input.startsWith(closeTag, i)) i = closeIdx + closeTag.length;

    return inner;
  }

  function tryParseAttachment(): NfmInlineContent | null {
    const match = input.slice(i).match(/^<attachment(?:\s+([^>]*))?\s*\/>/);
    if (!match) return null;

    const attrString = match[1] ?? "";
    const kind = getXmlAttr(attrString, "kind");
    const mode = getXmlAttr(attrString, "mode");
    const source = getXmlAttr(attrString, "source");
    const name = getXmlAttr(attrString, "name");
    const mimeType = getXmlAttr(attrString, "mime");
    const bytesValue = getXmlAttr(attrString, "bytes");
    const origin = getXmlAttr(attrString, "origin");

    if (
      (kind !== "text" && kind !== "file" && kind !== "folder")
      || (mode !== "materialized" && mode !== "link")
      || !source
      || !name
    ) {
      return null;
    }

    const bytes = bytesValue ? Number.parseInt(bytesValue, 10) : undefined;
    i += match[0].length;

    return {
      type: "attachment",
      kind,
      mode,
      source,
      name,
      ...(mimeType ? { mimeType } : {}),
      ...(typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? { bytes } : {}),
      ...(origin ? { origin } : {}),
    };
  }

  const items = parseRun({}, []);
  return mergeAdjacentText(items);
}

function isEscapable(ch: string): boolean {
  return "\\*~`$[]<>{}|^".includes(ch);
}

function unescapeNfm(value: string): string {
  if (!value.includes("\\")) return value;

  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (current === "\\" && next && isEscapable(next)) {
      result += next;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}

/** Merge adjacent text spans with identical styles */
function mergeAdjacentText(items: NfmInlineContent[]): NfmInlineContent[] {
  if (items.length <= 1) return items;
  const merged: NfmInlineContent[] = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === "text" &&
      item.type === "text" &&
      stylesEqual(prev.styles, item.styles)
    ) {
      (prev as { text: string }).text += item.text;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function stylesEqual(a: NfmStyleSet, b: NfmStyleSet): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.strikethrough === !!b.strikethrough &&
    !!a.underline === !!b.underline &&
    !!a.code === !!b.code &&
    (a.color ?? "") === (b.color ?? "")
  );
}
