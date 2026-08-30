import type { NfmInlineContent, NfmStyleSet, NfmColor } from "./types";
import { NFM_COLORS } from "./types";
import { parseDateMentionAttrs } from "./date-mention";
import { getXmlAttr, parseXmlAttrs } from "./xml-attributes";
import { parsePageDeepLink } from "../nodex-deeplink";

const AGENT_CONFIG_ATTRS = new Set([
  "mode",
  "provider",
  "model",
  "reasoning",
  "speed",
  "permission",
]);

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
      for (const t of terminators) {
        if (input.startsWith(t, i)) return (flushText(), items);
      }

      if (input[i] === "\\" && i + 1 < len && isEscapable(input[i + 1])) {
        textBuf += input[i + 1];
        i += 2;
        continue;
      }

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

      if (input.startsWith("<agent-config", i)) {
        const agentConfig = tryParseAgentConfig();
        if (agentConfig) {
          flushText();
          items.push(agentConfig);
          continue;
        }
      }

      if (input.startsWith("<mention-thread", i)) {
        const threadMention = tryParseThreadMention();
        if (threadMention) {
          flushText();
          items.push(threadMention);
          continue;
        }
      }

      if (input.startsWith("<mention-page", i)) {
        const pageMention = tryParsePageMention();
        if (pageMention) {
          flushText();
          items.push(pageMention);
          continue;
        }
      }

      if (input.startsWith("<mention-date", i)) {
        const dateMention = tryParseDateMention();
        if (dateMention) {
          flushText();
          items.push(dateMention);
          continue;
        }
      }

      if (input.startsWith("<span ", i)) {
        const spanResult = tryParseSpan(styles);
        if (spanResult) {
          flushText();
          items.push(...spanResult);
          continue;
        }
      }

      if (input[i] === "$" && !styles.code) {
        const math = tryParseMath();
        if (math) {
          flushText();
          items.push(math);
          continue;
        }
      }

      if (input[i] === "`" && !styles.code) {
        const fenceLength = repeatedRunLength(input, i, "`");
        const fence = "`".repeat(fenceLength);
        const end = findClosingCodeFence(input, i + fenceLength, fence);
        if (end !== -1) {
          flushText();
          let codeText = input.slice(i + fenceLength, end);
          if (codeText.startsWith(" ") && codeText.endsWith(" ") && codeText.trim().length > 0) {
            codeText = codeText.slice(1, -1);
          }
          items.push({ type: "text", text: codeText, styles: { ...styles, code: true } });
          i = end + fenceLength;
          continue;
        }
      }

      if (input.startsWith("**", i) && !styles.bold) {
        flushText();
        i += 2;
        const inner = parseRun({ ...styles, bold: true }, ["**"]);
        items.push(...inner);
        if (input.startsWith("**", i)) i += 2;
        continue;
      }

      if (input.startsWith("~~", i) && !styles.strikethrough) {
        flushText();
        i += 2;
        const inner = parseRun({ ...styles, strikethrough: true }, ["~~"]);
        items.push(...inner);
        if (input.startsWith("~~", i)) i += 2;
        continue;
      }

      if (input[i] === "*" && input[i + 1] !== "*" && !styles.italic) {
        flushText();
        i += 1;
        const inner = parseRun({ ...styles, italic: true }, ["*"]);
        items.push(...inner);
        if (i < len && input[i] === "*") i += 1;
        continue;
      }

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

    let depth = 0;
    let j = i + 1;
    while (j < len) {
      if (input[j] === "\\" && j + 1 < len) {
        j += 2;
        continue;
      }
      if (input[j] === "[") depth++;
      if (input[j] === "]") {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (j >= len) return null;

    const rawText = input.slice(i + 1, j);
    if (j + 1 >= len || input[j + 1] !== "(") return null;

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
    const parsedLabel = parseInlineContent(rawText);
    const uniformLabel =
      parsedLabel.length === 1 && parsedLabel[0]?.type === "text" ? parsedLabel[0] : null;
    return {
      type: "link",
      text: uniformLabel?.text ?? unescapeNfm(rawText),
      href,
      styles: { ...styles, ...(uniformLabel?.styles ?? {}) },
    };
  }

  function tryParseMath(): NfmInlineContent | null {
    if (input[i] !== "$" || !isInlineMathBoundaryBefore(input[i - 1])) return null;

    const sourceStart = i + 1;
    if (input[sourceStart] === "`") {
      const fenceLength = repeatedRunLength(input, sourceStart, "`");
      const fence = "`".repeat(fenceLength);
      const sourceEnd = findClosingCodeFence(input, sourceStart + fenceLength, fence);
      if (sourceEnd === -1) return null;

      const closingDollar = sourceEnd + fenceLength;
      if (input[closingDollar] !== "$" || !isInlineMathBoundaryAfter(input[closingDollar + 1])) {
        return null;
      }

      let source = input.slice(sourceStart + fenceLength, sourceEnd);
      if (source.startsWith(" ") && source.endsWith(" ") && source.length >= 2) {
        source = source.slice(1, -1);
      }
      i = closingDollar + 1;
      return { type: "math", source };
    }

    if (sourceStart >= len || /\s/u.test(input[sourceStart]!)) return null;
    let sourceEnd = sourceStart;
    while (sourceEnd < len) {
      if (input[sourceEnd] === "\\" && sourceEnd + 1 < len) {
        sourceEnd += 2;
        continue;
      }
      if (input[sourceEnd] !== "$") {
        sourceEnd += 1;
        continue;
      }

      const source = input.slice(sourceStart, sourceEnd);
      if (
        source.length > 0 &&
        !/\s$/u.test(source) &&
        isInlineMathBoundaryAfter(input[sourceEnd + 1])
      ) {
        i = sourceEnd + 1;
        return { type: "math", source };
      }
      sourceEnd += 1;
    }
    return null;
  }

  function tryParseSpan(styles: NfmStyleSet): NfmInlineContent[] | null {
    const spanOpenRe = /^<span\s+(underline="true"|color\??="([^"]*)")>/;
    const match = input.slice(i).match(spanOpenRe);
    if (!match) return null;

    const fullMatch = match[0];
    const isUnderline = match[1] === 'underline="true"';
    const colorValue = match[2] as NfmColor | undefined;
    const afterOpen = i + fullMatch.length;
    const closeTag = "</span>";
    const closeIdx = input.indexOf(closeTag, afterOpen);
    if (closeIdx === -1) return null;

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
      (kind !== "text" && kind !== "file" && kind !== "folder") ||
      (mode !== "materialized" && mode !== "link") ||
      !source ||
      !name
    ) {
      return null;
    }

    let bytes: number | undefined;
    if (bytesValue) {
      const parsed = Number.parseInt(bytesValue, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        bytes = parsed;
      }
    }

    i += match[0].length;
    return {
      type: "attachment",
      kind,
      mode,
      source,
      name,
      ...(mimeType ? { mimeType } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(origin ? { origin } : {}),
    };
  }

  function tryParseAgentConfig(): NfmInlineContent | null {
    const match = input.slice(i).match(/^<agent-config(?:\s+([^>]*))?\s*\/>/);
    if (!match) return null;

    const rawAttributes = match[1] ?? "";
    const attributes = parseXmlAttrs(rawAttributes);
    const unmatchedAttributes = rawAttributes.replace(/[A-Za-z][A-Za-z0-9_-]*="[^"]*"/g, "").trim();
    const unknownAttributes = [
      ...Object.keys(attributes).filter((name) => !AGENT_CONFIG_ATTRS.has(name)),
      ...(unmatchedAttributes ? ["invalid"] : []),
    ];

    i += match[0].length;
    return {
      type: "agentConfig",
      ...(attributes.mode ? { mode: attributes.mode } : {}),
      ...(attributes.provider ? { provider: attributes.provider } : {}),
      ...(attributes.model ? { model: attributes.model } : {}),
      ...(attributes.reasoning ? { reasoning: attributes.reasoning } : {}),
      ...(attributes.speed ? { speed: attributes.speed } : {}),
      ...(attributes.permission ? { permission: attributes.permission } : {}),
      ...(unknownAttributes.length > 0 ? { unknownAttributes } : {}),
      ...(rawAttributes.trim().length > 0 ? { rawAttributes } : {}),
    };
  }

  function tryParseThreadMention(): NfmInlineContent | null {
    const match = input.slice(i).match(/^<mention-thread(?:\s+([^>]*))?\s*\/>/);
    if (!match) return null;

    const attrString = match[1] ?? "";
    const uuid = getXmlAttr(attrString, "uuid")?.trim();
    if (!uuid) return null;

    i += match[0].length;
    return {
      type: "threadMention",
      uuid,
    };
  }

  function tryParsePageMention(): NfmInlineContent | null {
    const match = input.slice(i).match(/^<mention-page(?:\s+([^>]*))?\s*\/>/);
    if (!match) return null;

    const rawAttributes = match[1] ?? "";
    const attributes = parseXmlAttrs(rawAttributes);
    const unmatchedAttributes = rawAttributes.replace(/[A-Za-z][A-Za-z0-9_-]*="[^"]*"/g, "").trim();
    if (
      unmatchedAttributes ||
      Object.keys(attributes).length !== 1 ||
      typeof attributes.url !== "string"
    ) {
      return null;
    }
    const target = parsePageDeepLink(attributes.url);
    if (!target) return null;

    i += match[0].length;
    return {
      type: "pageMention",
      targetPageId: target.pageId,
    };
  }

  function tryParseDateMention(): NfmInlineContent | null {
    const match = input.slice(i).match(/^<mention-date(?:\s+([^>]*))?\s*\/>/);
    if (!match) return null;

    const dateMention = parseDateMentionAttrs(match[1] ?? "");
    if (!dateMention) return null;

    i += match[0].length;
    return dateMention;
  }

  return parseRun({}, []);
}

function repeatedRunLength(input: string, start: number, marker: string): number {
  let end = start;
  while (input[end] === marker) end += 1;
  return end - start;
}

function findClosingCodeFence(input: string, start: number, fence: string): number {
  let candidate = input.indexOf(fence, start);
  while (candidate !== -1) {
    const runStartIsExact = candidate === 0 || input[candidate - 1] !== "`";
    const runEnd = candidate + fence.length;
    const runEndIsExact = runEnd === input.length || input[runEnd] !== "`";
    if (runStartIsExact && runEndIsExact) return candidate;
    candidate = input.indexOf(fence, candidate + fence.length);
  }
  return -1;
}

function isEscapable(char: string): boolean {
  return "\\*~`$[]<>{}|^".includes(char);
}

function isInlineMathBoundaryBefore(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char) || "([{“‘".includes(char);
}

function isInlineMathBoundaryAfter(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char) || ".,;:!?)]}”’".includes(char);
}

function unescapeNfm(text: string): string {
  return text.replace(/\\([\\*~`$\[\]<>{}|^])/g, "$1");
}
