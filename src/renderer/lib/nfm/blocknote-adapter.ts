/**
 * Bidirectional adapter between NfmBlock[] and BlockNote Block[]/PartialBlock[].
 */
import type {
  NfmBlock,
  NfmInlineContent,
  NfmStyleSet,
  NfmColor,
  NfmBgColor,
  NfmTextColor,
} from "./types";
import { NFM_BG_COLORS, NFM_TEXT_COLORS } from "./types";
import { parseInlineContent } from "./parser-inline";
import { serializeInlineContent } from "./serializer-inline";

// BlockNote types - using generic shapes to avoid tight coupling to specific schema
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BNBlock = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BNPartialBlock = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BNInlineContent = any;

// --- NFM → BlockNote ---

/**
 * Convert NFM blocks to BlockNote partial blocks.
 * When `toggleStates` is provided, toggle blocks receive explicit IDs and their
 * open/closed state is recorded in the map (keyed by block ID).
 */
export function nfmToBlockNote(
  blocks: NfmBlock[],
  toggleStates?: Map<string, boolean>,
): BNPartialBlock[] {
  return blocks.map((b) => nfmBlockToBN(b, toggleStates));
}

function nfmBlockToBN(
  block: NfmBlock,
  toggleStates?: Map<string, boolean>,
): BNPartialBlock {
  const children = block.children.map((b) => nfmBlockToBN(b, toggleStates));
  const props = colorToProps(block.color);

  switch (block.type) {
    case "paragraph":
      return {
        type: "paragraph",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };

    case "heading": {
      const isToggleHeading = block.isToggleable === true;
      const headingId =
        isToggleHeading && toggleStates ? crypto.randomUUID() : undefined;
      if (headingId && toggleStates) {
        toggleStates.set(headingId, block.isOpen === true);
      }
      return {
        ...(headingId ? { id: headingId } : {}),
        type: "heading",
        props: {
          ...props,
          level: block.level,
          ...(isToggleHeading ? { isToggleable: true } : {}),
        },
        content: nfmInlineToBN(block.content),
        children,
      };
    }

    case "bulletListItem":
      return {
        type: "bulletListItem",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };

    case "numberedListItem":
      return {
        type: "numberedListItem",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };

    case "checkListItem":
      return {
        type: "checkListItem",
        props: { ...props, checked: block.checked },
        content: nfmInlineToBN(block.content),
        children,
      };

    case "toggle": {
      const toggleId = toggleStates ? crypto.randomUUID() : undefined;
      if (toggleId && toggleStates) {
        toggleStates.set(toggleId, block.isOpen === true);
      }
      return {
        ...(toggleId ? { id: toggleId } : {}),
        type: "toggleListItem",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };
    }

    case "blockquote":
      return {
        type: "quote",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };

    case "codeBlock":
      return {
        type: "codeBlock",
        props: { language: block.language },
        content: [{ type: "text", text: block.code, styles: {} }],
        children,
      };

    case "callout":
      return {
        type: "callout",
        props: { ...props, icon: block.icon || "💡" },
        content: nfmInlineToBN(block.content),
        children,
      };

    case "image":
      return {
        type: "image",
        props: {
          ...props,
          url: block.source,
          caption: serializeInlineContent(block.caption),
          ...(block.previewWidth !== undefined
            ? { previewWidth: block.previewWidth }
            : {}),
        },
        children,
      };

    case "toggleListInlineView":
      return {
        type: "toggleListInlineView",
        props: {
          sourceProjectId: block.sourceProjectId,
          rulesV2B64: block.rulesV2B64 ?? "",
          propertyOrderCsv: (block.propertyOrder ?? ["priority", "estimate", "status", "tags"]).join(","),
          hiddenPropertiesCsv: (block.hiddenProperties ?? []).join(","),
          showEmptyEstimate: block.showEmptyEstimate === true ? "true" : "false",
        },
        children: [],
      };

    case "cardRef":
      return {
        type: "cardRef",
        props: {
          sourceProjectId: block.sourceProjectId,
          cardId: block.cardId,
        },
        children: [],
      };

    case "cardToggle":
      return {
        type: "cardToggle",
        props: {
          cardId: block.cardId,
          meta: block.meta,
          snapshot: block.snapshot ?? "",
          sourceProjectId: block.sourceProjectId ?? "",
          sourceColumnId: block.sourceColumnId ?? "",
          sourceColumnName: block.sourceColumnName ?? "",
        },
        content: nfmInlineToBN(block.content),
        children,
      };

    case "divider":
      return {
        type: "divider",
        children,
      };

    case "emptyBlock":
      return {
        type: "paragraph",
        content: [],
        children,
      };
  }
}

function nfmInlineToBN(items: NfmInlineContent[]): BNInlineContent[] {
  return items.map((item) => {
    if (item.type === "linebreak") {
      // BlockNote represents hard breaks as newlines within text
      return { type: "text", text: "\n", styles: {} };
    }

    if (item.type === "attachment") {
      return {
        type: "attachment",
        props: {
          kind: item.kind,
          mode: item.mode,
          source: item.source,
          name: item.name,
          ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          ...(item.kind !== "folder" && item.bytes !== undefined ? { bytes: item.bytes } : {}),
          ...(item.origin ? { origin: item.origin } : {}),
        },
      };
    }

    if (item.type === "link") {
      return {
        type: "link",
        href: item.href,
        content: [{ type: "text", text: item.text, styles: nfmStylesToBN(item.styles) }],
      };
    }

    // text
    return {
      type: "text",
      text: item.text,
      styles: nfmStylesToBN(item.styles),
    };
  });
}

function nfmStylesToBN(styles: NfmStyleSet): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};
  if (styles.bold) result.bold = true;
  if (styles.italic) result.italic = true;
  if (styles.strikethrough) result.strike = true;
  if (styles.underline) result.underline = true;
  if (styles.code) result.code = true;
  if (styles.color) {
    if (NFM_BG_COLORS.includes(styles.color as NfmBgColor)) {
      result.backgroundColor = nfmBgToBlockNoteBackground(styles.color as NfmBgColor);
    } else {
      result.textColor = styles.color;
    }
  }
  return result;
}

function colorToProps(
  color?: NfmColor,
): Record<string, string> {
  if (!color) return {};
  if (NFM_BG_COLORS.includes(color as NfmBgColor)) {
    return { backgroundColor: nfmBgToBlockNoteBackground(color as NfmBgColor) };
  }
  return { textColor: color };
}

// --- BlockNote → NFM ---

export function blockNoteToNfm(blocks: BNBlock[]): NfmBlock[] {
  return blocks.map(bnBlockToNfm).filter((b): b is NfmBlock => b !== null);
}

function normalizeCodeBlockLanguage(language: unknown): string {
  if (typeof language !== "string") return "";

  const normalizedLanguage = language.trim();
  if (normalizedLanguage === "text") return "";

  return normalizedLanguage;
}

function bnBlockToNfm(block: BNBlock): NfmBlock | null {
  const children = block.children
    ? blockNoteToNfm(block.children)
    : [];
  const color = propsToColor(block.props);

  switch (block.type) {
    case "paragraph": {
      const content = bnInlineToNfm(block.content);
      if (content.length === 0 && color === undefined) {
        return { type: "emptyBlock", children };
      }

      return { type: "paragraph", content, color, children };
    }

    case "heading": {
      const level = Math.min(Math.max(block.props?.level ?? 1, 1), 4) as
        | 1
        | 2
        | 3
        | 4;
      return {
        type: "heading",
        level,
        ...(block.props?.isToggleable === true ? { isToggleable: true } : {}),
        content: bnInlineToNfm(block.content),
        color,
        children,
      };
    }

    case "bulletListItem":
      return {
        type: "bulletListItem",
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "numberedListItem":
      return {
        type: "numberedListItem",
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "checkListItem":
      return {
        type: "checkListItem",
        checked: block.props?.checked ?? false,
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "toggleListItem":
      return {
        type: "toggle",
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "quote":
      return {
        type: "blockquote",
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "codeBlock": {
      // Extract plain text from inline content
      const code = extractCodeText(block.content);
      return {
        type: "codeBlock",
        language: normalizeCodeBlockLanguage(block.props?.language),
        code,
        children,
      };
    }

    case "callout":
      return {
        type: "callout",
        icon: block.props?.icon || undefined,
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "image": {
      const source = normalizeImageUrl(block.props?.url);
      if (!source) return null;
      const caption = normalizeImageCaption(block.props?.caption);
      const previewWidth = normalizePreviewWidth(block.props?.previewWidth);

      return {
        type: "image",
        source,
        caption,
        ...(previewWidth !== undefined ? { previewWidth } : {}),
        color,
        children,
      };
    }

    case "toggleListInlineView": {
      const sourceProjectId = normalizeString(block.props?.sourceProjectId) ?? "default";
      const rulesV2B64 = normalizeString(block.props?.rulesV2B64);
      const propertyOrder = parseCsvString(block.props?.propertyOrderCsv).filter(isToggleListPropertyKey);
      const hiddenProperties = parseCsvString(block.props?.hiddenPropertiesCsv).filter(isToggleListPropertyKey);
      const showEmptyEstimate = normalizeBooleanString(block.props?.showEmptyEstimate);

      return {
        type: "toggleListInlineView",
        sourceProjectId,
        ...(rulesV2B64 && rulesV2B64.length > 0 ? { rulesV2B64 } : {}),
        ...(propertyOrder.length > 0 ? { propertyOrder } : {}),
        ...(hiddenProperties.length > 0 ? { hiddenProperties } : {}),
        ...(showEmptyEstimate !== undefined ? { showEmptyEstimate } : {}),
        children: [],
      };
    }

    case "cardRef": {
      const sourceProjectId = normalizeString(block.props?.sourceProjectId) ?? "default";
      const cardId = normalizeString(block.props?.cardId) ?? "";

      return {
        type: "cardRef",
        sourceProjectId,
        cardId,
        children: [],
      };
    }

    case "cardToggle": {
      const cardId = normalizeString(block.props?.cardId) ?? "";
      const meta = normalizeString(block.props?.meta) ?? "";
      const snapshot = normalizeString(block.props?.snapshot);
      const sourceProjectId = normalizeString(block.props?.sourceProjectId);
      const sourceColumnId = normalizeString(block.props?.sourceColumnId);
      const sourceColumnName = normalizeString(block.props?.sourceColumnName);

      return {
        type: "cardToggle",
        cardId,
        meta,
        ...(snapshot !== undefined ? { snapshot } : {}),
        ...(sourceProjectId !== undefined ? { sourceProjectId } : {}),
        ...(sourceColumnId !== undefined ? { sourceColumnId } : {}),
        ...(sourceColumnName !== undefined ? { sourceColumnName } : {}),
        content: bnInlineToNfm(block.content),
        children,
      };
    }

    case "divider":
      return { type: "divider", children };

    default:
      // Unknown block type - convert to paragraph if it has content
      if (block.content && Array.isArray(block.content)) {
        return {
          type: "paragraph",
          content: bnInlineToNfm(block.content),
          color,
          children,
        };
      }
      return null;
  }
}

/**
 * Apply current toggle open/closed states from the editor DOM to NFM blocks.
 * Walks BN doc blocks and NFM blocks in parallel (same tree structure).
 */
/**
 * Apply current toggle open/closed states from the editor DOM to NFM blocks.
 * Collects toggle states from BN blocks (via DOM queries), then applies them
 * to NFM toggle blocks in pre-order traversal. This approach is immune to
 * index misalignment caused by null-filtered blocks (e.g. images with empty URLs).
 */
export function applyToggleStatesFromDom(
  bnBlocks: BNBlock[],
  nfmBlocks: NfmBlock[],
  editorElement: HTMLElement,
): void {
  // Step 1: Collect toggle open/closed states from DOM by walking BN blocks
  const toggleStates: boolean[] = [];
  collectToggleStatesFromDom(bnBlocks, editorElement, toggleStates);

  // Step 2: Apply states to NFM toggle blocks in the same pre-order traversal
  applyToggleStatesToNfm(nfmBlocks, toggleStates, { idx: 0 });
}

function collectToggleStatesFromDom(
  blocks: BNBlock[],
  editorElement: HTMLElement,
  states: boolean[],
): void {
  for (const bn of blocks) {
    const isToggle =
      bn.type === "toggleListItem" ||
      (bn.type === "heading" && bn.props?.isToggleable);

    if (isToggle && bn.id) {
      const escaped = CSS.escape(bn.id);
      const wrapper = editorElement.querySelector(
        `.bn-block[data-id="${escaped}"] > .bn-block-content .bn-toggle-wrapper`,
      );
      states.push(wrapper?.getAttribute("data-show-children") === "true");
    }

    if (bn.children?.length) {
      collectToggleStatesFromDom(bn.children, editorElement, states);
    }
  }
}

function applyToggleStatesToNfm(
  blocks: NfmBlock[],
  states: boolean[],
  counter: { idx: number },
): void {
  for (const nfm of blocks) {
    const isToggle =
      nfm.type === "toggle" ||
      (nfm.type === "heading" && nfm.isToggleable);

    if (isToggle && counter.idx < states.length) {
      if (states[counter.idx]) {
        (nfm as { isOpen?: boolean }).isOpen = true;
      } else {
        delete (nfm as { isOpen?: boolean }).isOpen;
      }
      counter.idx++;
    }

    if (nfm.children?.length) {
      applyToggleStatesToNfm(nfm.children, states, counter);
    }
  }
}

function bnInlineToNfm(content: BNInlineContent[] | undefined): NfmInlineContent[] {
  if (!content || !Array.isArray(content)) return [];
  const items: NfmInlineContent[] = [];

  for (const item of content) {
    if (!item || !item.type) continue;

    if (item.type === "attachment") {
      const kind = normalizeString(item.props?.kind);
      const mode = normalizeString(item.props?.mode);
      const source = normalizeString(item.props?.source);
      const name = normalizeString(item.props?.name);
      const mimeType = normalizeString(item.props?.mimeType);
      const bytes = normalizeNonNegativeNumber(item.props?.bytes);
      const origin = normalizeString(item.props?.origin);

      if (
        (kind !== "text" && kind !== "file" && kind !== "folder")
        || (mode !== "materialized" && mode !== "link")
        || !source
        || !name
      ) {
        continue;
      }

      items.push({
        type: "attachment",
        kind,
        mode,
        source,
        name,
        ...(mimeType ? { mimeType } : {}),
        ...(kind !== "folder" && bytes !== undefined ? { bytes } : {}),
        ...(origin ? { origin } : {}),
      });
    } else if (item.type === "link") {
      // Link content is StyledText[]. Flatten to plain text + first style set.
      // NFM links don't support per-span formatting, so we take the dominant style.
      const contentArr = item.content || [];
      const text = contentArr.map((c: BNInlineContent) => c.text || "").join("");
      const styles = contentArr.length > 0 && contentArr[0].styles
        ? bnStylestoNfm(contentArr[0].styles)
        : {};
      pushLinkWithLinebreaks(items, text, item.href, styles);
    } else if (item.type === "text") {
      pushTextWithLinebreaks(
        items,
        item.text ?? "",
        bnStylestoNfm(item.styles || {}),
      );
    }
  }

  return items;
}

function pushTextWithLinebreaks(
  items: NfmInlineContent[],
  text: string,
  styles: NfmStyleSet,
) {
  const parts = text.split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part) {
      items.push({
        type: "text",
        text: part,
        styles,
      });
    }

    if (index < parts.length - 1) {
      items.push({ type: "linebreak" });
    }
  }
}

function pushLinkWithLinebreaks(
  items: NfmInlineContent[],
  text: string,
  href: string,
  styles: NfmStyleSet,
) {
  const parts = text.split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part) {
      items.push({
        type: "link",
        text: part,
        href,
        styles,
      });
    }

    if (index < parts.length - 1) {
      items.push({ type: "linebreak" });
    }
  }
}

function bnStylestoNfm(
  styles: Record<string, boolean | string>,
): NfmStyleSet {
  const result: NfmStyleSet = {};
  if (styles.bold) result.bold = true;
  if (styles.italic) result.italic = true;
  if (styles.strike) result.strikethrough = true;
  if (styles.underline) result.underline = true;
  if (styles.code) result.code = true;

  // Map textColor/backgroundColor to NfmColor
  const textColor = toNfmTextColor(styles.textColor);
  if (textColor) {
    result.color = textColor;
  }
  if (styles.backgroundColor && styles.backgroundColor !== "default") {
    const mapped = blockNoteBackgroundToNfmBg(styles.backgroundColor);
    if (mapped) result.color = mapped;
  }

  return result;
}

function propsToColor(
  props?: Record<string, unknown>,
): NfmColor | undefined {
  if (!props) return undefined;
  if (props.backgroundColor && props.backgroundColor !== "default") {
    return blockNoteBackgroundToNfmBg(props.backgroundColor);
  }
  return toNfmTextColor(props.textColor);
}

function toNfmTextColor(value: unknown): NfmTextColor | undefined {
  if (typeof value !== "string" || value === "default") return undefined;
  return NFM_TEXT_COLORS.includes(value as NfmTextColor)
    ? (value as NfmTextColor)
    : undefined;
}

function nfmBgToBlockNoteBackground(color: NfmBgColor): string {
  const mapping: Record<NfmBgColor, string> = {
    gray_bg: "gray",
    brown_bg: "brown",
    orange_bg: "orange",
    yellow_bg: "yellow",
    green_bg: "green",
    blue_bg: "blue",
    purple_bg: "purple",
    pink_bg: "pink",
    red_bg: "red",
  };

  return mapping[color];
}

function blockNoteBackgroundToNfmBg(value: unknown): NfmBgColor | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  const mapping: Record<string, NfmBgColor> = {
    gray: "gray_bg",
    brown: "brown_bg",
    orange: "orange_bg",
    yellow: "yellow_bg",
    green: "green_bg",
    blue: "blue_bg",
    purple: "purple_bg",
    pink: "pink_bg",
    red: "red_bg",
  };

  return mapping[normalized];
}

function extractCodeText(content: BNInlineContent[] | undefined): string {
  if (!content || !Array.isArray(content)) return "";
  return content
    .map((item: BNInlineContent) => item.text || "")
    .join("");
}

function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCsvString(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeBooleanString(value: unknown): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function isToggleListPropertyKey(value: string): value is "priority" | "estimate" | "status" | "tags" {
  return value === "priority" || value === "estimate" || value === "status" || value === "tags";
}

function normalizeImageCaption(value: unknown): NfmInlineContent[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return parseInlineContent(value);
}

function normalizePreviewWidth(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
