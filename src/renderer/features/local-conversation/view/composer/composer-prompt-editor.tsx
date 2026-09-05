import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { baseKeymap } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import { Schema, Slice, type DOMOutputSpec, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, EditorView } from "@tiptap/pm/view";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  composerSuggestionPluginKey,
  createComposerSuggestionPlugin,
  createComposerSuggestionTransaction,
  inactiveComposerSuggestionState,
  readComposerSuggestionState,
  type ComposerSlashSuggestionSource,
  type ComposerSuggestionState,
  type ComposerSuggestionTransactionMeta,
} from "./composer-suggestion-state";
import {
  handleComposerFilePaste,
  type ComposerPastedFiles,
} from "./image-attachments/composer-image-data-transfer";

export type ComposerPromptMentionKind =
  | "agent"
  | "app"
  | "chatgpt-conversation"
  | "file"
  | "plugin"
  | "skill"
  | "site"
  | "thread";

export interface ComposerPromptMentionInput {
  readonly kind: ComposerPromptMentionKind;
  readonly name: string;
  readonly path: string;
  readonly conversationId?: string | null;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly fsPath?: string | null;
  readonly iconUrl?: string | null;
  readonly iconUrlDark?: string | null;
  readonly brandColor?: string | null;
  readonly promptLinkLabel?: string | null;
}

export type ComposerSuggestionAction =
  | "backspace"
  | "complete-query"
  | "dismiss"
  | "insert-mention"
  | "next"
  | "previous";

interface ComposerPromptMentionAttrs {
  readonly kind: ComposerPromptMentionKind;
  readonly name: string;
  readonly conversationId: string;
  readonly displayName: string;
  readonly path: string;
  readonly description: string;
  readonly fsPath: string;
  readonly iconUrl: string;
  readonly iconUrlDark: string;
  readonly brandColor: string;
  readonly promptLinkLabel: string;
}

export interface ComposerPromptMentionMetadataInventory {
  readonly apps: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly logoUrl: string | null;
    readonly logoUrlDark: string | null;
  }[];
  readonly plugins: readonly {
    readonly name: string;
    readonly displayName: string;
    readonly description: string | null;
    readonly path: string;
    readonly iconUrl: string | null;
    readonly iconUrlDark: string | null;
    readonly brandColor: string | null;
  }[];
  readonly skills: readonly {
    readonly name: string;
    readonly displayName: string;
    readonly description: string;
    readonly iconUrl: string | null;
    readonly brandColor: string | null;
    readonly path: string;
  }[];
}

function normalizeMentionIconUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized) return "";
  if (/^data:image\/(?:png|gif|jpeg|webp|svg\+xml);base64,/iu.test(normalized)) {
    return normalized;
  }
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "app:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function normalizeComposerAppMentionName(name: string): string {
  const normalized = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "app";
}

function normalizePromptMention(input: ComposerPromptMentionInput): ComposerPromptMentionAttrs {
  return {
    kind: input.kind,
    name: input.name.trim(),
    conversationId: input.conversationId?.trim() ?? "",
    displayName: input.displayName?.trim() || input.name.trim(),
    path: input.path.trim(),
    description: input.description?.trim() ?? "",
    fsPath: input.fsPath?.trim() || input.path.trim(),
    iconUrl: normalizeMentionIconUrl(input.iconUrl),
    iconUrlDark: normalizeMentionIconUrl(input.iconUrlDark),
    brandColor: /^#[\da-f]{3,8}$/iu.test(input.brandColor?.trim() ?? "")
      ? input.brandColor!.trim()
      : "",
    promptLinkLabel: input.kind === "skill" ? (input.promptLinkLabel?.trim() ?? "") : "",
  };
}

function mentionLabel(attrs: ComposerPromptMentionAttrs): string {
  if (attrs.kind === "file" || attrs.kind === "site" || attrs.kind === "chatgpt-conversation") {
    return attrs.displayName;
  }
  if (attrs.kind === "skill" && attrs.promptLinkLabel) {
    return attrs.promptLinkLabel;
  }
  return `${attrs.kind === "app" || attrs.kind === "skill" ? "$" : "@"}${attrs.name}`;
}

function mentionDisplayText(attrs: ComposerPromptMentionAttrs): string {
  return attrs.kind === "agent" || attrs.kind === "thread"
    ? `@${attrs.displayName}`
    : attrs.displayName;
}

function isLikelyComposerFileMentionPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/") ||
    /^[a-z]:[\\/]/iu.test(path) ||
    path.includes("/") ||
    path.includes("\\")
  );
}

function isUrlLikeComposerMentionPath(path: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(path) ||
    /^(?:mailto|tel):/iu.test(path) ||
    /^www\./iu.test(path)
  );
}

function humanizeComposerSkillName(name: string): string {
  const leafName = name.split(":").at(-1)?.trim() || name;
  if (!/[-_]/u.test(leafName)) return leafName;
  return leafName
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseComposerSkillPromptLabel(label: string): {
  readonly name: string;
  readonly displayName: string;
} {
  const queryIndex = label.indexOf("?");
  if (queryIndex < 0) {
    return {
      name: label,
      displayName: humanizeComposerSkillName(label),
    };
  }
  const name = label.slice(0, queryIndex).trim();
  const displayName = new URLSearchParams(label.slice(queryIndex + 1)).get("label")?.trim();
  return {
    name,
    displayName: displayName || humanizeComposerSkillName(name),
  };
}

export function parseComposerPromptMentionLink(
  rawLabel: string,
  rawPath: string,
): ComposerPromptMentionInput | null {
  const path = rawPath.trim();
  const label = rawLabel.trim();
  if (!path || !label) return null;
  const prefix = label.startsWith("@") ? "@" : label.startsWith("$") ? "$" : null;
  const unprefixedLabel = prefix ? label.slice(1).trim() : label;
  if (!unprefixedLabel) return null;

  const kind: ComposerPromptMentionKind | null = path.startsWith("plugin://")
    ? "plugin"
    : path.startsWith("app://")
      ? "app"
      : path.startsWith("thread://") ||
          path.startsWith("agent://") ||
          path.startsWith("subagent://")
        ? "agent"
        : path.startsWith("chatgpt-conversation://")
          ? "chatgpt-conversation"
          : path.startsWith("site://") || path.startsWith("sites-project://")
            ? "site"
            : prefix === "$" && !isUrlLikeComposerMentionPath(path)
              ? "skill"
              : !isUrlLikeComposerMentionPath(path) &&
                  (prefix === null || isLikelyComposerFileMentionPath(path))
                ? "file"
                : null;
  if (kind === null) return null;

  const skillLabel = kind === "skill" ? parseComposerSkillPromptLabel(unprefixedLabel) : null;
  return {
    kind,
    name:
      kind === "app"
        ? normalizeComposerAppMentionName(unprefixedLabel)
        : (skillLabel?.name ?? unprefixedLabel),
    displayName: skillLabel?.displayName ?? unprefixedLabel,
    path,
    ...(kind === "skill" ? { promptLinkLabel: label } : {}),
  };
}

export function serializeComposerPromptMentionLink(input: ComposerPromptMentionInput): string {
  const mention = normalizePromptMention(input);
  if (!mention.name || !mention.path) return "";
  return `[${mentionLabel(mention)}](${mention.path})`;
}

function parseMentionDom(element: HTMLElement): ComposerPromptMentionAttrs | false {
  const kind = element.dataset.mentionKind as ComposerPromptMentionKind | undefined;
  const name = element.dataset.mentionName?.trim() ?? "";
  const path = element.dataset.promptLinkHref?.trim() ?? "";
  if (!kind || !name || !path) return false;

  return normalizePromptMention({
    kind,
    name,
    displayName: element.dataset.mentionDisplayName,
    description: element.dataset.mentionDescription,
    conversationId: element.dataset.mentionConversationId,
    fsPath: element.dataset.mentionFsPath,
    path,
    iconUrl: element.dataset.mentionIcon,
    iconUrlDark: element.dataset.mentionIconDark,
    brandColor: element.dataset.mentionBrandColor,
    promptLinkLabel: element.dataset.promptLinkLabel,
  });
}

function readRequiredMentionDomAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name)?.trim() ?? "";
  return value || null;
}

function parseFileMentionDom(element: HTMLElement): ComposerPromptMentionAttrs | false {
  const displayName = readRequiredMentionDomAttribute(element, "at-mention-label");
  const path = readRequiredMentionDomAttribute(element, "at-mention-path");
  const fsPath = readRequiredMentionDomAttribute(element, "at-mention-fs-path");
  if (!displayName || !path || !fsPath) return false;
  return normalizePromptMention({
    kind: "file",
    name: displayName,
    displayName,
    path,
    fsPath,
  });
}

function parseAgentMentionDom(element: HTMLElement): ComposerPromptMentionAttrs | false {
  const name = readRequiredMentionDomAttribute(element, "agent-mention-name");
  const path = readRequiredMentionDomAttribute(element, "agent-mention-path");
  if (!name || !path) return false;
  return normalizePromptMention({
    kind: "agent",
    name,
    displayName: element.getAttribute("agent-mention-display-name") ?? name,
    conversationId: element.getAttribute("agent-mention-conversation-id"),
    path,
  });
}

function parseCapabilityMentionDom(
  element: HTMLElement,
  kind: "app" | "plugin" | "skill",
): ComposerPromptMentionAttrs | false {
  const namespace = `${kind}-mention`;
  const name = readRequiredMentionDomAttribute(element, `${namespace}-name`);
  const path = readRequiredMentionDomAttribute(element, `${namespace}-path`);
  if (!name || !path) return false;
  return normalizePromptMention({
    kind,
    name,
    displayName: element.getAttribute(`${namespace}-display-name`) ?? name,
    path,
    iconUrl: element.getAttribute(`${namespace}-icon`),
    brandColor: element.getAttribute(`${namespace}-brand-color`),
    promptLinkLabel: element.dataset.promptLinkLabel,
  });
}

function parseChatGptConversationMentionDom(
  element: HTMLElement,
): ComposerPromptMentionAttrs | false {
  const conversationId = readRequiredMentionDomAttribute(
    element,
    "chatgpt-conversation-mention-conversation-id",
  );
  const path = readRequiredMentionDomAttribute(element, "chatgpt-conversation-mention-path");
  const title = readRequiredMentionDomAttribute(element, "chatgpt-conversation-mention-title");
  if (!conversationId || !path || !title) return false;
  return normalizePromptMention({
    kind: "chatgpt-conversation",
    name: title,
    displayName: title,
    conversationId,
    path,
  });
}

function parseSitesProjectMentionDom(element: HTMLElement): ComposerPromptMentionAttrs | false {
  const path = readRequiredMentionDomAttribute(element, "sites-project-mention-path");
  const title = readRequiredMentionDomAttribute(element, "sites-project-mention-title");
  if (!path || !title) return false;
  return normalizePromptMention({
    kind: "site",
    name: title,
    displayName: title,
    path,
  });
}

function buildMentionDom(node: ProseMirrorNode): DOMOutputSpec {
  const attrs = node.attrs as ComposerPromptMentionAttrs;
  const label = mentionLabel(attrs);
  const domAttrs: Record<string, string> = {
    "data-composer-mention": "true",
    "data-mention-kind": attrs.kind,
    "data-mention-name": attrs.name,
    "data-mention-conversation-id": attrs.conversationId,
    "data-mention-display-name": attrs.displayName,
    "data-mention-description": attrs.description,
    "data-mention-fs-path": attrs.fsPath,
    "data-mention-icon": attrs.iconUrl,
    "data-mention-icon-dark": attrs.iconUrlDark,
    "data-mention-brand-color": attrs.brandColor,
    "data-prompt-link-href": attrs.path,
    "data-prompt-link-label": label,
    contenteditable: "false",
    class:
      "group/inline-mention cursor-interaction inline-flex max-w-full gap-[3px] px-0.5 align-bottom font-medium text-[color:var(--inline-mention-color)] [--inline-mention-color:var(--inline-mention-base-color)] [--inline-mention-base-color:color-mix(in_srgb,var(--color-token-text-link-foreground)_80%,var(--color-token-foreground)_20%)] hover:underline hover:decoration-current hover:decoration-dashed hover:decoration-[0.5px] hover:underline-offset-2 dark:[--inline-mention-color:var(--inline-mention-dark-base-color,var(--inline-mention-base-color))]",
  };
  if (attrs.brandColor) {
    domAttrs.style = [
      `--inline-mention-base-color:${attrs.brandColor}`,
      `--inline-mention-dark-base-color:color-mix(in oklch, ${attrs.brandColor} 50%, var(--color-token-foreground) 50%)`,
    ].join(";");
  }
  if (attrs.kind === "file") {
    domAttrs["at-mention-label"] = attrs.displayName;
    domAttrs["at-mention-path"] = attrs.path;
    domAttrs["at-mention-fs-path"] = attrs.fsPath;
  } else if (attrs.kind === "site") {
    domAttrs["sites-project-mention-path"] = attrs.path;
    domAttrs["sites-project-mention-title"] = attrs.displayName;
  } else if (attrs.kind === "chatgpt-conversation") {
    domAttrs["chatgpt-conversation-mention-conversation-id"] = attrs.path.slice(
      "chatgpt-conversation://".length,
    );
    domAttrs["chatgpt-conversation-mention-path"] = attrs.path;
    domAttrs["chatgpt-conversation-mention-title"] = attrs.displayName;
  } else {
    const namespacedPrefix = attrs.kind === "thread" ? "agent-mention" : `${attrs.kind}-mention`;
    domAttrs[`${namespacedPrefix}-name`] = attrs.name;
    domAttrs[`${namespacedPrefix}-display-name`] = attrs.displayName;
    domAttrs[`${namespacedPrefix}-path`] = attrs.path;
    domAttrs[`${namespacedPrefix}-icon`] = attrs.iconUrl;
    domAttrs[`${namespacedPrefix}-brand-color`] = attrs.brandColor;
    if (namespacedPrefix === "agent-mention" && attrs.conversationId) {
      domAttrs["agent-mention-conversation-id"] = attrs.conversationId;
    }
  }

  const icon: DOMOutputSpec = attrs.iconUrl
    ? attrs.iconUrlDark && attrs.iconUrlDark !== attrs.iconUrl
      ? [
          "span",
          {
            "aria-hidden": "true",
            class: "relative h-[1lh] w-4 shrink-0",
          },
          [
            "img",
            {
              src: attrs.iconUrlDark,
              alt: "",
              draggable: "false",
              referrerpolicy: "no-referrer",
              class:
                "icon-xs absolute top-1/2 hidden -translate-y-1/2 rounded-2xs object-contain dark:block",
            },
          ],
          [
            "img",
            {
              src: attrs.iconUrl,
              alt: "",
              draggable: "false",
              referrerpolicy: "no-referrer",
              class:
                "icon-xs absolute top-1/2 -translate-y-1/2 rounded-2xs object-contain dark:hidden",
            },
          ],
        ]
      : [
          "span",
          {
            "aria-hidden": "true",
            class: "relative h-[1lh] w-4 shrink-0",
          },
          [
            "img",
            {
              src: attrs.iconUrl,
              alt: "",
              draggable: "false",
              referrerpolicy: "no-referrer",
              class: "icon-xs absolute top-1/2 -translate-y-1/2 rounded-2xs object-contain",
            },
          ],
        ]
    : [
        "span",
        {
          "aria-hidden": "true",
          class: "relative h-[1lh] w-4 shrink-0 text-center text-[10px] leading-[1lh]",
        },
        "",
      ];

  return [
    "span",
    domAttrs,
    icon,
    ["span", { class: "min-w-0 break-words" }, mentionDisplayText(attrs)],
  ];
}

const promptSchema = new Schema({
  nodes: {
    doc: {
      content: "paragraph+",
    },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    mention: {
      inline: true,
      group: "inline",
      atom: true,
      draggable: false,
      selectable: false,
      leafText: (node) => mentionLabel(node.attrs as ComposerPromptMentionAttrs),
      attrs: {
        kind: { default: "file" },
        name: { default: "" },
        conversationId: { default: "" },
        displayName: { default: "" },
        path: { default: "" },
        description: { default: "" },
        fsPath: { default: "" },
        iconUrl: { default: "" },
        iconUrlDark: { default: "" },
        brandColor: { default: "" },
        promptLinkLabel: { default: "" },
      },
      parseDOM: [
        {
          tag: "span[data-composer-mention='true']",
          getAttrs: (node) => (node instanceof HTMLElement ? parseMentionDom(node) : false),
        },
        {
          tag: "span[at-mention-label][at-mention-path][at-mention-fs-path]",
          getAttrs: (node) => (node instanceof HTMLElement ? parseFileMentionDom(node) : false),
        },
        {
          tag: "span[agent-mention-name][agent-mention-path]",
          getAttrs: (node) => (node instanceof HTMLElement ? parseAgentMentionDom(node) : false),
        },
        ...(["app", "plugin", "skill"] as const).map((kind) => ({
          tag: `span[${kind}-mention-name][${kind}-mention-path]`,
          getAttrs: (node: HTMLElement) =>
            node instanceof HTMLElement ? parseCapabilityMentionDom(node, kind) : false,
        })),
        {
          tag: "span[chatgpt-conversation-mention-conversation-id][chatgpt-conversation-mention-path][chatgpt-conversation-mention-title]",
          getAttrs: (node) =>
            node instanceof HTMLElement ? parseChatGptConversationMentionDom(node) : false,
        },
        {
          tag: "span[sites-project-mention-path][sites-project-mention-title]",
          getAttrs: (node) =>
            node instanceof HTMLElement ? parseSitesProjectMentionDom(node) : false,
        },
      ],
      toDOM: buildMentionDom,
    },
    text: {
      group: "inline",
    },
  },
  marks: {},
});

export const COMPOSER_LARGE_PASTE_CHAR_THRESHOLD = 5_000;

export function classifyComposerPaste(text: string): "inline" | "attachment" {
  return text.length >= COMPOSER_LARGE_PASTE_CHAR_THRESHOLD ? "attachment" : "inline";
}

function handleComposerLargeTextPaste(
  event: ClipboardEvent,
  onLargeTextPaste: ((text: string) => boolean) | undefined,
): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  const hasFiles =
    (clipboard.files?.length ?? 0) > 0 ||
    Array.from(clipboard.items ?? []).some((item) => item.kind === "file");
  if (hasFiles) return false;

  const text = clipboard.getData("text/plain");
  if (classifyComposerPaste(text) !== "attachment") return false;
  if (onLargeTextPaste?.(text) !== true) return false;
  event.preventDefault();
  return true;
}

function handleComposerPaste(
  event: ClipboardEvent,
  onPasteFiles: ((payload: ComposerPastedFiles) => boolean) | undefined,
  onLargeTextPaste: ((text: string) => boolean) | undefined,
): boolean {
  return (
    handleComposerFilePaste(event, onPasteFiles) ||
    handleComposerLargeTextPaste(event, onLargeTextPaste)
  );
}

const promptEditingKeymapPlugin = keymap({
  ...baseKeymap,
  "Shift-Enter": baseKeymap.Enter,
});

function serializePromptSlice(slice: Slice): string {
  let value = "";
  let sawBlock = false;
  slice.content.forEach((node) => {
    if (node.isText) {
      value += node.text ?? "";
      return;
    }
    if (node.type.name === "mention") {
      const attrs = node.attrs as ComposerPromptMentionAttrs;
      value += serializeComposerPromptMentionLink(attrs);
      return;
    }
    if (node.type.name === "paragraph") {
      if (sawBlock) value += "\n";
      value += serializePromptInlineContent(node);
      sawBlock = true;
      return;
    }
    value += node.textBetween(0, node.content.size, "\n");
  });
  return value;
}

const promptClipboardPlugin = new Plugin({
  props: {
    clipboardTextParser: (text) => buildPromptTextSlice(text),
    clipboardTextSerializer: serializePromptSlice,
  },
});

export interface ComposerPromptEditorHandle {
  getElement: () => HTMLElement | null;
  focus: () => void;
  focusAtEnd: () => void;
  setText: (text: string) => string;
  setPromptText: (text: string) => string;
  insertText: (text: string) => string;
  insertMention: (mention: ComposerPromptMentionInput) => string;
  replaceTextRange: (range: { from: number; to: number; text: string }) => string;
  clearRange: (range: { from: number; to: number }) => string;
  toggleContextSuggestions: () => void;
  openSlashSubmenu: (source: ComposerSlashSuggestionSource | null) => void;
  closeSuggestions: () => void;
  dismissSuggestions: () => void;
  getSelection: () => { from: number; to: number } | null;
  getSuggestionState: () => ComposerSuggestionState;
  getText: () => string;
  getPersistedText: () => string;
  isCursorAtEnd: () => boolean;
  syncMentionMetadata: (inventory: ComposerPromptMentionMetadataInventory) => void;
}

interface ComposerPromptEditorProps {
  value: string;
  placeholder: string;
  disabled: boolean;
  singleLine?: boolean;
  compact?: boolean;
  allowSlashCommands?: boolean;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
  onLargeTextPaste?: (text: string) => boolean;
  onPasteFiles?: (payload: ComposerPastedFiles) => boolean;
  onSuggestionStateChange?: (state: ComposerSuggestionState) => void;
  onSuggestionAction?: (action: ComposerSuggestionAction) => boolean;
  onIntrinsicContentWidthChange?: (widthPx: number) => void;
  "data-composer-prompt-frame"?: "true";
  className?: string;
}

export function measureComposerPromptIntrinsicWidth(element: HTMLElement): number {
  const hasContent = Boolean(
    element.textContent?.length || element.querySelector("[data-composer-mention='true']"),
  );
  if (!hasContent) return 0;

  const previousStyle = element.getAttribute("style");
  try {
    element.style.position = "fixed";
    element.style.visibility = "hidden";
    element.style.width = "max-content";
    element.style.minWidth = "0";
    element.style.maxWidth = "none";
    return Math.max(0, element.getBoundingClientRect().width);
  } finally {
    if (previousStyle === null) {
      element.removeAttribute("style");
    } else {
      element.setAttribute("style", previousStyle);
    }
  }
}

function buildPromptEditorAttributes({
  placeholder,
  singleLine,
  compact = false,
}: {
  placeholder: string;
  singleLine: boolean;
  compact?: boolean;
}) {
  return {
    "aria-label": placeholder,
    "data-virtualkeyboard": "true",
    "data-codex-composer": "true",
    spellcheck: "true",
    translate: "no",
    style: [
      "font-size: var(--codex-chat-font-size)",
      "height: auto",
      "resize: none",
      `min-height: ${compact ? "0" : singleLine ? "1.25rem" : "2.75rem"}`,
    ].join("; "),
  };
}

export function buildPromptDoc(value: string): ProseMirrorNode {
  const lines = value.split(/\r\n?|\n/u);
  const paragraphType = promptSchema.nodes.paragraph;
  const mentionType = promptSchema.nodes.mention;
  const paragraphs = (lines.length > 0 ? lines : [""]).map((line) => {
    const children: ProseMirrorNode[] = [];
    const mentionPattern = /\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
    let cursor = 0;
    for (const match of line.matchAll(mentionPattern)) {
      const index = match.index;
      if (index > cursor) {
        children.push(promptSchema.text(line.slice(cursor, index)));
      }
      const mention = parseComposerPromptMentionLink(match[1] ?? "", match[2] ?? "");
      if (mention) {
        children.push(mentionType.create(normalizePromptMention(mention)));
      } else {
        children.push(promptSchema.text(match[0]));
      }
      cursor = index + match[0].length;
    }
    if (cursor < line.length) {
      children.push(promptSchema.text(line.slice(cursor)));
    }
    return paragraphType.create(null, children.length > 0 ? children : undefined);
  });

  return promptSchema.nodes.doc.create(null, paragraphs);
}

function buildPromptTextSlice(value: string): Slice {
  return new Slice(buildPromptDoc(value).content, 1, 1);
}

function replacePromptTextRange(
  transaction: Transaction,
  range: { from: number; to: number; text: string },
): Transaction {
  if (!/[\r\n]/u.test(range.text)) {
    return transaction.insertText(range.text, range.from, range.to);
  }

  const textSelection = TextSelection.create(transaction.doc, range.from, range.to);
  return transaction.setSelection(textSelection).replaceSelection(buildPromptTextSlice(range.text));
}

function serializePromptInlineContent(paragraph: ProseMirrorNode): string {
  let value = "";
  paragraph.forEach((child) => {
    if (child.isText) {
      value += child.text ?? "";
      return;
    }
    if (child.type.name !== "mention") return;

    const attrs = child.attrs as ComposerPromptMentionAttrs;
    value += serializeComposerPromptMentionLink(attrs);
  });
  return value;
}

function readPromptDocText(doc: ProseMirrorNode): string {
  const paragraphs: string[] = [];
  doc.forEach((paragraph) => {
    paragraphs.push(serializePromptInlineContent(paragraph));
  });
  return paragraphs.join("\n");
}

export function promptTextOffsetToDocPosition(doc: ProseMirrorNode, offset: number): number {
  const targetOffset = Math.max(0, offset);
  if (targetOffset === 0) return 0;

  let textOffset = 0;
  let documentPosition = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const paragraph = doc.child(index);
    if (index > 0) {
      textOffset += 1;
      if (targetOffset <= textOffset) return documentPosition + 1;
    }

    const paragraphTextLength = serializePromptInlineContent(paragraph).length;
    if (targetOffset <= textOffset + paragraphTextLength) {
      const relativeOffset = targetOffset - textOffset;
      let serializedOffset = 0;
      let childDocumentOffset = 0;
      for (let childIndex = 0; childIndex < paragraph.childCount; childIndex += 1) {
        const child = paragraph.child(childIndex);
        const serialized = child.isText
          ? (child.text ?? "")
          : child.type.name === "mention"
            ? `[${mentionLabel(child.attrs as ComposerPromptMentionAttrs)}](${String(child.attrs.path)})`
            : "";
        if (relativeOffset <= serializedOffset + serialized.length) {
          if (child.isText) {
            return documentPosition + 1 + childDocumentOffset + (relativeOffset - serializedOffset);
          }
          return (
            documentPosition +
            1 +
            childDocumentOffset +
            (relativeOffset === serialized.length ? child.nodeSize : 0)
          );
        }
        serializedOffset += serialized.length;
        childDocumentOffset += child.nodeSize;
      }
      return documentPosition + paragraph.nodeSize - 1;
    }

    textOffset += paragraphTextLength;
    documentPosition += paragraph.nodeSize;
  }

  return doc.content.size;
}

function isPromptDocEmpty(doc: ProseMirrorNode): boolean {
  return doc.childCount === 1 && (doc.firstChild?.content.size ?? 0) === 0;
}

function getPromptDocEndSelection(doc: ProseMirrorNode) {
  return TextSelection.atEnd(doc);
}

function syncPromptMentionMetadata(
  view: EditorView,
  inventory: ComposerPromptMentionMetadataInventory,
): void {
  const skillsByPath = new Map(inventory.skills.map((skill) => [skill.path, skill] as const));
  const skillsByName = new Map(
    inventory.skills.map((skill) => [skill.name.toLocaleLowerCase(), skill] as const),
  );
  const appsByPath = new Map<string, ComposerPromptMentionMetadataInventory["apps"][number]>(
    inventory.apps.map((app) => [`app://${app.id}`, app] as const),
  );
  const appsByName = new Map(
    inventory.apps.flatMap((app) => [
      [app.id.toLocaleLowerCase(), app] as const,
      [normalizeComposerAppMentionName(app.name), app] as const,
    ]),
  );
  const pluginsByPath = new Map(inventory.plugins.map((plugin) => [plugin.path, plugin] as const));
  const pluginsByName = new Map(
    inventory.plugins.flatMap((plugin) => [
      [plugin.name.toLocaleLowerCase(), plugin] as const,
      [plugin.displayName.toLocaleLowerCase(), plugin] as const,
    ]),
  );
  let transaction = view.state.tr;
  let changed = false;

  view.state.doc.descendants((node, position) => {
    if (node.type.name !== "mention") return true;
    const attrs = node.attrs as ComposerPromptMentionAttrs;
    let next: ComposerPromptMentionAttrs | null = null;

    if (attrs.kind === "skill") {
      const skill =
        skillsByPath.get(attrs.path) ?? skillsByName.get(attrs.name.toLocaleLowerCase());
      if (skill) {
        next = normalizePromptMention({
          ...attrs,
          kind: "skill",
          name: skill.name,
          displayName: skill.displayName,
          description: skill.description,
          iconUrl: skill.iconUrl,
          brandColor: skill.brandColor,
          path: skill.path,
        });
      }
    } else if (attrs.kind === "app") {
      const app = appsByPath.get(attrs.path) ?? appsByName.get(attrs.name.toLocaleLowerCase());
      if (app) {
        next = normalizePromptMention({
          ...attrs,
          kind: "app",
          name: normalizeComposerAppMentionName(app.name),
          displayName: app.name,
          description: app.description,
          path: `app://${app.id}`,
          iconUrl: app.logoUrl,
          iconUrlDark: app.logoUrlDark,
        });
      }
    } else if (attrs.kind === "plugin") {
      const plugin =
        pluginsByPath.get(attrs.path) ?? pluginsByName.get(attrs.name.toLocaleLowerCase());
      if (plugin) {
        next = normalizePromptMention({
          ...attrs,
          kind: "plugin",
          name: plugin.name,
          displayName: plugin.displayName,
          description: plugin.description,
          path: plugin.path,
          iconUrl: plugin.iconUrl,
          iconUrlDark: plugin.iconUrlDark,
          brandColor: plugin.brandColor,
        });
      }
    }

    if (!next) return true;
    const metadataChanged = (Object.keys(next) as (keyof ComposerPromptMentionAttrs)[]).some(
      (key) => next[key] !== attrs[key],
    );
    if (!metadataChanged) return true;

    changed = true;
    transaction = transaction.setNodeMarkup(position, undefined, next);
    return true;
  });

  if (changed) view.dispatch(transaction);
}

function createPromptPlaceholderPlugin(placeholderRef: { current: string }): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        if (!isPromptDocEmpty(state.doc)) return null;

        const firstParagraph = state.doc.firstChild;
        if (!firstParagraph) return null;

        return DecorationSet.create(state.doc, [
          Decoration.node(0, firstParagraph.nodeSize, {
            class: "placeholder",
            "data-placeholder": placeholderRef.current,
          }),
        ]);
      },
    },
  });
}

function createPromptEditorState(
  value: string,
  placeholderRef: { current: string },
  allowSlashCommands = true,
): EditorState {
  const doc = buildPromptDoc(value);
  return EditorState.create({
    schema: promptSchema,
    doc,
    selection: getPromptDocEndSelection(doc),
    // Direct EditorView handlers own composer shortcuts first. Unconsumed
    // editing keys fall through to ProseMirror's structural commands.
    plugins: [
      createComposerSuggestionPlugin({ allowSlashCommands }),
      promptEditingKeymapPlugin,
      promptClipboardPlugin,
      createPromptPlaceholderPlugin(placeholderRef),
    ],
  });
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps
>(function ComposerPromptEditor(
  {
    value,
    placeholder,
    disabled,
    singleLine = false,
    compact = false,
    allowSlashCommands = true,
    onChange,
    onKeyDown,
    onLargeTextPaste,
    onPasteFiles,
    onSuggestionStateChange,
    onSuggestionAction,
    onIntrinsicContentWidthChange,
    "data-composer-prompt-frame": dataComposerPromptFrame,
    className,
  },
  ref,
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onKeyDownRef = useRef(onKeyDown);
  const onLargeTextPasteRef = useRef(onLargeTextPaste);
  const onPasteFilesRef = useRef(onPasteFiles);
  const onSuggestionStateChangeRef = useRef(onSuggestionStateChange);
  const onSuggestionActionRef = useRef(onSuggestionAction);
  const onIntrinsicContentWidthChangeRef = useRef(onIntrinsicContentWidthChange);
  const placeholderRef = useRef(placeholder);
  const singleLineRef = useRef(singleLine);
  const compactRef = useRef(compact);
  const allowSlashCommandsRef = useRef(allowSlashCommands);
  const disabledRef = useRef(disabled);
  valueRef.current = value;
  onChangeRef.current = onChange;
  onKeyDownRef.current = onKeyDown;
  onLargeTextPasteRef.current = onLargeTextPaste;
  onPasteFilesRef.current = onPasteFiles;
  onSuggestionStateChangeRef.current = onSuggestionStateChange;
  onSuggestionActionRef.current = onSuggestionAction;
  onIntrinsicContentWidthChangeRef.current = onIntrinsicContentWidthChange;
  placeholderRef.current = placeholder;
  singleLineRef.current = singleLine;
  compactRef.current = compact;
  allowSlashCommandsRef.current = allowSlashCommands;
  disabledRef.current = disabled;

  const emitSuggestionState = useCallback((view: EditorView | null) => {
    onSuggestionStateChangeRef.current?.(
      view ? readComposerSuggestionState(view.state) : inactiveComposerSuggestionState(),
    );
  }, []);

  const reportIntrinsicContentWidth = useCallback(() => {
    const element = viewRef.current?.dom;
    if (!(element instanceof HTMLElement)) return;
    onIntrinsicContentWidthChangeRef.current?.(measureComposerPromptIntrinsicWidth(element));
  }, []);

  const dispatchSuggestionMeta = useCallback(
    (view: EditorView, meta: ComposerSuggestionTransactionMeta) => {
      view.dispatch(createComposerSuggestionTransaction(view.state, meta));
    },
    [],
  );

  const handleSuggestionKeyDown = useCallback(
    (view: EditorView, event: KeyboardEvent): boolean => {
      const suggestion = readComposerSuggestionState(view.state);
      if (!suggestion.active) return false;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dispatchSuggestionMeta(view, { type: "dismiss" });
        onSuggestionActionRef.current?.("dismiss");
        return true;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const handled =
          onSuggestionActionRef.current?.(event.key === "ArrowDown" ? "next" : "previous") === true;
        if (!handled) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        const action = event.key === "Tab" ? "complete-query" : "insert-mention";
        if (onSuggestionActionRef.current?.(action) !== true) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }

      if (event.key === "Backspace" && suggestion.kind === "slash-command") {
        const range = suggestion.range;
        const selectionOutsideRange =
          suggestion.activation === "synthetic" &&
          range !== null &&
          (!view.state.selection.empty ||
            view.state.selection.from < range.from ||
            view.state.selection.from > range.to);
        if (selectionOutsideRange) {
          dispatchSuggestionMeta(view, { type: "close" });
          onSuggestionActionRef.current?.("backspace");
          return true;
        }
        if (suggestion.query.length > 0) return false;
        if (suggestion.source !== null) {
          dispatchSuggestionMeta(view, {
            type: "set-source",
            source: null,
          });
          onSuggestionActionRef.current?.("backspace");
          return true;
        }
        if (suggestion.activation === "synthetic") {
          dispatchSuggestionMeta(view, { type: "close" });
          onSuggestionActionRef.current?.("backspace");
          return true;
        }
      }

      return false;
    },
    [dispatchSuggestionMeta],
  );

  const setText = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) {
      onChangeRef.current(text);
      return text;
    }

    const transaction = view.state.tr.replaceWith(
      0,
      view.state.doc.content.size,
      buildPromptDoc(text).content,
    );
    transaction.setSelection(getPromptDocEndSelection(transaction.doc)).scrollIntoView();
    view.dispatch(transaction);
    return readPromptDocText(view.state.doc);
  }, []);

  const replaceTextRange = useCallback((range: { from: number; to: number; text: string }) => {
    const view = viewRef.current;
    if (!view) {
      const nextValue = `${valueRef.current.slice(0, range.from)}${range.text}${valueRef.current.slice(range.to)}`;
      onChangeRef.current(nextValue);
      return nextValue;
    }

    const from = Math.max(0, Math.min(range.from, view.state.doc.content.size));
    const to = Math.max(from, Math.min(range.to, view.state.doc.content.size));
    view.dispatch(
      replacePromptTextRange(view.state.tr, {
        from,
        to,
        text: range.text,
      }).scrollIntoView(),
    );
    view.focus();
    return readPromptDocText(view.state.doc);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getElement: () => viewRef.current?.dom ?? null,
      focus: () => {
        viewRef.current?.focus();
      },
      focusAtEnd: () => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(
          view.state.tr.setSelection(getPromptDocEndSelection(view.state.doc)).scrollIntoView(),
        );
        view.focus();
      },
      setText,
      setPromptText: setText,
      insertText: (text: string) => {
        const view = viewRef.current;
        if (!view) {
          const nextValue = `${valueRef.current}${text}`;
          onChangeRef.current(nextValue);
          return nextValue;
        }

        const { from, to } = view.state.selection;
        view.dispatch(replacePromptTextRange(view.state.tr, { from, to, text }).scrollIntoView());
        view.focus();
        return readPromptDocText(view.state.doc);
      },
      insertMention: (mention) => {
        const view = viewRef.current;
        const normalizedMention = normalizePromptMention(mention);
        if (!normalizedMention.name || !normalizedMention.path) {
          return view ? readPromptDocText(view.state.doc) : valueRef.current;
        }
        if (!view) {
          const nextValue = `${valueRef.current}[${mentionLabel(normalizedMention)}](${normalizedMention.path}) `;
          onChangeRef.current(nextValue);
          return nextValue;
        }

        const suggestion = readComposerSuggestionState(view.state);
        const from =
          suggestion.active && suggestion.range ? suggestion.range.from : view.state.selection.from;
        const to =
          suggestion.active && suggestion.range ? suggestion.range.to : view.state.selection.to;
        const mentionNode = promptSchema.nodes.mention.create(normalizedMention);
        let transaction = view.state.tr.replaceRangeWith(from, to, mentionNode);
        const mentionEnd = transaction.mapping.map(from, -1) + mentionNode.nodeSize;
        const resolvedEnd = transaction.doc.resolve(mentionEnd);
        const nextTextCharacter =
          resolvedEnd.parentOffset < resolvedEnd.parent.content.size
            ? resolvedEnd.parent.childAfter(resolvedEnd.parentOffset).node?.text?.[0]
            : undefined;
        const cursor =
          nextTextCharacter && /\s/u.test(nextTextCharacter) ? mentionEnd : mentionEnd + 1;
        if (cursor > mentionEnd) {
          transaction = transaction.insertText(" ", mentionEnd);
        }
        transaction
          .setSelection(
            TextSelection.create(transaction.doc, Math.min(cursor, transaction.doc.content.size)),
          )
          .setMeta(composerSuggestionPluginKey, { type: "close" })
          .scrollIntoView();
        view.dispatch(transaction);
        view.focus();
        return readPromptDocText(view.state.doc);
      },
      replaceTextRange,
      clearRange: (range) => replaceTextRange({ ...range, text: "" }),
      toggleContextSuggestions: () => {
        const view = viewRef.current;
        if (!view) return;
        const suggestion = readComposerSuggestionState(view.state);
        dispatchSuggestionMeta(
          view,
          suggestion.active && suggestion.activation === "synthetic" && suggestion.trigger === "+"
            ? { type: "close" }
            : {
                type: "open-synthetic",
                from: view.state.selection.from,
                kind: "at-mention",
                trigger: "+",
              },
        );
        view.focus();
      },
      openSlashSubmenu: (source) => {
        const view = viewRef.current;
        if (!view) return;
        const suggestion = readComposerSuggestionState(view.state);
        if (suggestion.active && suggestion.kind === "slash-command" && suggestion.range !== null) {
          const queryFrom = suggestion.anchorPos ?? suggestion.range.from;
          const transaction = view.state.tr;
          if (suggestion.range.to > queryFrom) {
            transaction.delete(queryFrom, suggestion.range.to);
          }
          view.dispatch(
            transaction.setMeta(composerSuggestionPluginKey, {
              type: "set-source",
              source,
            } satisfies ComposerSuggestionTransactionMeta),
          );
        } else if (source !== null) {
          const transaction = view.state.tr;
          if (!transaction.selection.empty) {
            transaction.setSelection(
              TextSelection.create(transaction.doc, transaction.selection.to),
            );
          }
          view.dispatch(
            transaction.setMeta(composerSuggestionPluginKey, {
              type: "open-synthetic",
              from: transaction.selection.from,
              kind: "slash-command",
              trigger: "/",
            } satisfies ComposerSuggestionTransactionMeta),
          );
          dispatchSuggestionMeta(view, { type: "set-source", source });
        }
        view.focus();
      },
      closeSuggestions: () => {
        const view = viewRef.current;
        if (!view) return;
        dispatchSuggestionMeta(view, { type: "close" });
      },
      dismissSuggestions: () => {
        const view = viewRef.current;
        if (!view) return;
        dispatchSuggestionMeta(view, { type: "dismiss" });
      },
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return null;
        return {
          from: view.state.selection.from,
          to: view.state.selection.to,
        };
      },
      getSuggestionState: () => {
        const view = viewRef.current;
        return view ? readComposerSuggestionState(view.state) : inactiveComposerSuggestionState();
      },
      getText: () => {
        const view = viewRef.current;
        return view ? readPromptDocText(view.state.doc) : valueRef.current;
      },
      getPersistedText: () => {
        const view = viewRef.current;
        return view ? readPromptDocText(view.state.doc) : valueRef.current;
      },
      isCursorAtEnd: () => {
        const view = viewRef.current;
        if (!view || !view.state.selection.empty) return false;

        const domSelection = view.dom.ownerDocument.getSelection();
        if (!domSelection || !domSelection.isCollapsed || domSelection.rangeCount === 0)
          return false;
        if (!domSelection.anchorNode || !view.dom.contains(domSelection.anchorNode)) return false;

        const endPosition = getPromptDocEndSelection(view.state.doc).from;
        if (view.state.selection.from !== endPosition) return false;

        try {
          return view.posAtDOM(domSelection.anchorNode, domSelection.anchorOffset) === endPosition;
        } catch {
          return true;
        }
      },
      syncMentionMetadata: (inventory) => {
        const view = viewRef.current;
        if (!view) return;
        syncPromptMentionMetadata(view, inventory);
      },
    }),
    [dispatchSuggestionMeta, replaceTextRange, setText],
  );

  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount || viewRef.current) return;

    const view = new EditorView(mount, {
      state: createPromptEditorState(
        valueRef.current,
        placeholderRef,
        allowSlashCommandsRef.current,
      ),
      editable: () => !disabledRef.current,
      attributes: buildPromptEditorAttributes({
        placeholder: placeholderRef.current,
        singleLine: singleLineRef.current,
        compact: compactRef.current,
      }),
      handleKeyDown: (currentView, event) =>
        handleSuggestionKeyDown(currentView, event) || onKeyDownRef.current(event),
      handlePaste: (_view, event) =>
        handleComposerPaste(event, onPasteFilesRef.current, onLargeTextPasteRef.current),
      dispatchTransaction(transaction) {
        const currentView = viewRef.current;
        if (!currentView) return;

        const nextState = currentView.state.apply(transaction);
        currentView.updateState(nextState);
        reportIntrinsicContentWidth();
        const nextValue = readPromptDocText(nextState.doc);

        if (nextValue !== valueRef.current) {
          onChangeRef.current(nextValue);
        }
        emitSuggestionState(currentView);
      },
    });

    viewRef.current = view;
    emitSuggestionState(view);
    reportIntrinsicContentWidth();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [
    dispatchSuggestionMeta,
    emitSuggestionState,
    handleSuggestionKeyDown,
    reportIntrinsicContentWidth,
  ]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({
      editable: () => !disabled,
      attributes: buildPromptEditorAttributes({ placeholder, singleLine, compact }),
      handleKeyDown: (currentView, event) =>
        handleSuggestionKeyDown(currentView, event) || onKeyDownRef.current(event),
      handlePaste: (_currentView, event) =>
        handleComposerPaste(event, onPasteFilesRef.current, onLargeTextPasteRef.current),
    });
  }, [disabled, dispatchSuggestionMeta, handleSuggestionKeyDown, placeholder, singleLine, compact]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentValue = readPromptDocText(view.state.doc);
    if (currentValue !== value) {
      view.updateState(
        createPromptEditorState(value, placeholderRef, allowSlashCommandsRef.current),
      );
      emitSuggestionState(view);
      reportIntrinsicContentWidth();
      return;
    }

    view.dispatch(view.state.tr.setMeta("prompt-placeholder", placeholder));
  }, [emitSuggestionState, placeholder, reportIntrinsicContentWidth, value]);

  useEffect(() => {
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) reportIntrinsicContentWidth();
    });
    return () => {
      active = false;
    };
  }, [reportIntrinsicContentWidth]);

  return (
    <div
      data-composer-prompt-frame={dataComposerPromptFrame}
      data-nodex-keyboard-context={dataComposerPromptFrame ? "composer" : undefined}
      data-single-line={singleLine ? "true" : "false"}
      className={[
        "text-size-chat [&_.ProseMirror]:focus-visible:outline-none text-token-foreground h-auto [&_.ProseMirror]:h-auto [&_.ProseMirror]:resize-none [&_.ProseMirror_p]:m-0 text-base [&_.ProseMirror]:leading-5",
        singleLine
          ? "max-h-5 overflow-hidden [&_.ProseMirror]:min-h-5"
          : "max-h-[25dvh] overflow-y-auto [&_.ProseMirror]:min-h-[2rem]",
        disabled ? "opacity-60" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      ref={mountRef}
    />
  );
});

export type ComposerPromptEditorKeyboardEvent = ReactKeyboardEvent<HTMLElement> | KeyboardEvent;
