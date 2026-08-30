import type { NfmInlineContent, NfmStyleSet } from "./types";
import { serializeDateMentionAttrs } from "./date-mention";
import { escapeXmlAttr } from "./xml-attributes";
import { buildPageDeepLink } from "../nodex-deeplink";

const ESCAPABLE = /[\\*~`$\[\]<>{}|^]/g;

function escapeNfm(text: string): string {
  return text.replace(ESCAPABLE, "\\$&");
}

export function serializeInlineContent(items: NfmInlineContent[]): string {
  return items.map(serializeItem).join("");
}

function serializeItem(item: NfmInlineContent): string {
  if (item.type === "linebreak") return "<br>";

  if (item.type === "attachment") {
    const attrs = [
      `kind="${escapeXmlAttr(item.kind)}"`,
      `mode="${escapeXmlAttr(item.mode)}"`,
      `source="${escapeXmlAttr(item.source)}"`,
      `name="${escapeXmlAttr(item.name)}"`,
    ];
    if (item.mimeType) attrs.push(`mime="${escapeXmlAttr(item.mimeType)}"`);
    if (item.kind !== "folder" && typeof item.bytes === "number" && Number.isFinite(item.bytes)) {
      attrs.push(`bytes="${Math.max(0, Math.floor(item.bytes))}"`);
    }
    if (item.origin) attrs.push(`origin="${escapeXmlAttr(item.origin)}"`);
    return `<attachment ${attrs.join(" ")} />`;
  }

  if (item.type === "agentConfig") {
    const attrs: string[] = [];
    if (item.mode) attrs.push(`mode="${escapeXmlAttr(item.mode)}"`);
    if (item.provider) attrs.push(`provider="${escapeXmlAttr(item.provider)}"`);
    if (item.model) attrs.push(`model="${escapeXmlAttr(item.model)}"`);
    if (item.reasoning) attrs.push(`reasoning="${escapeXmlAttr(item.reasoning)}"`);
    if (item.speed) attrs.push(`speed="${escapeXmlAttr(item.speed)}"`);
    if (item.permission) attrs.push(`permission="${escapeXmlAttr(item.permission)}"`);
    if (attrs.length === 0 && item.rawAttributes?.trim()) {
      return `<agent-config ${item.rawAttributes.trim()} />`;
    }
    return attrs.length > 0 ? `<agent-config ${attrs.join(" ")} />` : "<agent-config />";
  }

  if (item.type === "threadMention") {
    return `<mention-thread uuid="${escapeXmlAttr(item.uuid)}" />`;
  }

  if (item.type === "pageMention") {
    return `<mention-page url="${escapeXmlAttr(buildPageDeepLink({ pageId: item.targetPageId }))}" />`;
  }

  if (item.type === "dateMention") {
    const attrs = serializeDateMentionAttrs(item);
    return attrs ? `<mention-date ${attrs} />` : "";
  }

  if (item.type === "math") {
    return serializeInlineMath(item.source);
  }

  if (item.type === "link") {
    const inner = applyStyles(escapeNfm(item.text), item.styles);
    return `[${inner}](${item.href})`;
  }

  if (item.styles.code) {
    const longestBacktickRun = Math.max(
      0,
      ...[...item.text.matchAll(/`+/gu)].map((match) => match[0].length),
    );
    const fence = "`".repeat(longestBacktickRun + 1);
    const needsPadding = item.text.startsWith("`") || item.text.endsWith("`");
    return needsPadding ? `${fence} ${item.text} ${fence}` : `${fence}${item.text}${fence}`;
  }

  let text = escapeNfm(item.text);
  text = applyStyles(text, item.styles);
  return text;
}

function serializeInlineMath(source: string): string {
  if (
    source.length > 0 &&
    !source.includes("\n") &&
    !source.includes("$") &&
    !source.includes("`") &&
    source.trim() === source
  ) {
    return `$${source}$`;
  }

  const longestBacktickRun = Math.max(
    0,
    ...[...source.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  return `$${fence} ${source} ${fence}$`;
}

function applyStyles(text: string, styles: NfmStyleSet): string {
  if (!text) return text;
  if (styles.color) text = `<span color="${styles.color}">${text}</span>`;
  if (styles.underline) text = `<span underline="true">${text}</span>`;
  if (styles.strikethrough) text = `~~${text}~~`;
  if (styles.italic) text = `*${text}*`;
  if (styles.bold) text = `**${text}**`;
  return text;
}
