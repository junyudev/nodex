import { blockNoteToNfm, serializeNfm } from "../../../lib/nfm";
import type { CardInput } from "../../../lib/types";
import type { DragSessionBlock, EditorForExternalBlockDrop } from "./external-block-drag-session";
import {
  cardInputFromCardToggleSnapshot,
  parseCardToggleMetaOverrides,
} from "./card-toggle-snapshot";
import {
  readSmartPrefixParsingEnabled,
  readStripSmartPrefixFromTitleEnabled,
} from "../../../lib/smart-prefix-parsing";

const TEXT_LIKE_BLOCK_TYPES = new Set<string>([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
  "callout",
]);

const FALLBACK_TITLES: Record<string, string> = {
  codeBlock: "Code block",
  image: "Image",
  divider: "Divider",
  cardRef: "Card reference",
  cardToggle: "Card",
  toggleListInlineView: "Toggle list view",
};

const SMART_PREFIX_REGEX = /^([0-4])(XS|S|M|L|XL)?(\(([^()\s][^()]*)\))?(?::\s*|\s+|$)/i;

const SMART_PREFIX_PRIORITY_BY_DIGIT = {
  0: "p0-critical",
  1: "p1-high",
  2: "p2-medium",
  3: "p3-low",
  4: "p4-later",
} as const;

const SMART_PREFIX_ESTIMATE_BY_TOKEN = {
  XS: "xs",
  S: "s",
  M: "m",
  L: "l",
  XL: "xl",
} as const;

interface ParsedSmartPrefix {
  consumedPrefix: string;
  priority: CardInput["priority"];
  estimate?: CardInput["estimate"];
  tags: string[];
}

export interface BlockDropCardMapperOptions {
  smartPrefixParsingEnabled?: boolean;
  stripSmartPrefixFromTitleEnabled?: boolean;
}

type InlineContentItem = {
  type?: string;
  text?: string;
  content?: Array<{ text?: string }>;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inlineContentToText(content: unknown): string {
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return "";

  const text = content
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const inlineItem = item as InlineContentItem;
      if (inlineItem.type === "text") {
        return typeof inlineItem.text === "string" ? inlineItem.text : "";
      }
      if (inlineItem.type !== "link" || !Array.isArray(inlineItem.content)) return "";
      return inlineItem.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    })
    .join("");

  return normalizeText(text);
}

function fallbackTitleForBlock(block: DragSessionBlock): string {
  return FALLBACK_TITLES[block.type] ?? "Untitled block";
}

function hasInlineTitleContent(block: DragSessionBlock): boolean {
  return TEXT_LIKE_BLOCK_TYPES.has(block.type);
}

function serializeBlocks(blocks: DragSessionBlock[]): string {
  return serializeNfm(blockNoteToNfm(blocks));
}

function toStringProp(
  props: Record<string, unknown> | undefined,
  key: string,
): string {
  if (!props) return "";
  const value = props[key];
  return typeof value === "string" ? value : "";
}

function mapCardToggleBlockToCardInput(block: DragSessionBlock): CardInput {
  const props = typeof block.props === "object" && block.props
    ? block.props
    : undefined;
  const meta = toStringProp(props, "meta");
  const snapshot = toStringProp(props, "snapshot");
  const metaOverrides = parseCardToggleMetaOverrides(meta);
  const snapshotDefaults = cardInputFromCardToggleSnapshot(snapshot);

  const titleFromContent = inlineContentToText(block.content);
  const title = titleFromContent.length > 0
    ? titleFromContent
    : fallbackTitleForBlock(block);
  const children = Array.isArray(block.children) ? block.children : [];

  const result: CardInput = {
    title,
    description: serializeBlocks(children),
    ...snapshotDefaults,
  };

  if (metaOverrides.priority) {
    result.priority = metaOverrides.priority;
  }
  if (metaOverrides.hasEstimate) {
    result.estimate = metaOverrides.estimate ?? null;
  }
  if (metaOverrides.tags.length > 0) {
    result.tags = metaOverrides.tags;
  }

  return result;
}

function parseLeadingSmartPrefix(title: string): ParsedSmartPrefix | null {
  if (title.length === 0) return null;
  const match = SMART_PREFIX_REGEX.exec(title);
  if (!match) return null;

  const priorityToken = Number(match[1]) as 0 | 1 | 2 | 3 | 4;
  const priority = SMART_PREFIX_PRIORITY_BY_DIGIT[priorityToken];
  const estimateToken = match[2]?.toUpperCase() as keyof typeof SMART_PREFIX_ESTIMATE_BY_TOKEN | undefined;
  const estimate = estimateToken
    ? SMART_PREFIX_ESTIMATE_BY_TOKEN[estimateToken]
    : undefined;
  const tag = match[4]?.trim() ?? "";

  return {
    consumedPrefix: match[0],
    priority,
    ...(estimate ? { estimate } : {}),
    tags: tag.length > 0 ? [tag] : [],
  };
}

function resolveMapperOptions(
  options?: BlockDropCardMapperOptions,
): Required<BlockDropCardMapperOptions> {
  return {
    smartPrefixParsingEnabled: options?.smartPrefixParsingEnabled ?? readSmartPrefixParsingEnabled(),
    stripSmartPrefixFromTitleEnabled: options?.stripSmartPrefixFromTitleEnabled ?? readStripSmartPrefixFromTitleEnabled(),
  };
}

function resolveTitleWithSmartPrefix(
  block: DragSessionBlock,
  options: Required<BlockDropCardMapperOptions>,
): { title: string; smartPrefix: ParsedSmartPrefix | null } {
  const titleText = hasInlineTitleContent(block)
    ? inlineContentToText(block.content)
    : "";
  const fallbackTitle = fallbackTitleForBlock(block);
  const baseTitle = titleText.length > 0 ? titleText : fallbackTitle;

  if (!options.smartPrefixParsingEnabled || !hasInlineTitleContent(block) || titleText.length === 0) {
    return { title: baseTitle, smartPrefix: null };
  }

  const smartPrefix = parseLeadingSmartPrefix(titleText);
  if (!smartPrefix) {
    return { title: baseTitle, smartPrefix: null };
  }

  if (!options.stripSmartPrefixFromTitleEnabled) {
    return { title: baseTitle, smartPrefix };
  }

  const strippedTitle = titleText.slice(smartPrefix.consumedPrefix.length).trim();
  if (strippedTitle.length === 0) {
    return { title: titleText, smartPrefix };
  }

  return { title: strippedTitle, smartPrefix };
}

export function resolveTopLevelDraggedBlocks(
  editor: EditorForExternalBlockDrop,
  draggedIds: string[],
): DragSessionBlock[] {
  if (draggedIds.length === 0) return [];

  const selectedIds = new Set(draggedIds);
  const topLevelIds = draggedIds.filter((id) => {
    let current = editor.getParentBlock(id);
    while (current) {
      if (selectedIds.has(current.id)) return false;
      current = editor.getParentBlock(current.id);
    }
    return true;
  });

  return topLevelIds
    .map((id) => editor.getBlock(id))
    .filter((block): block is DragSessionBlock => block !== undefined);
}

export function mapDraggedBlocksToCardInputs(
  blocks: DragSessionBlock[],
  options?: BlockDropCardMapperOptions,
): CardInput[] {
  const resolvedOptions = resolveMapperOptions(options);

  return blocks.map((block) => {
    if (block.type === "cardToggle") {
      return mapCardToggleBlockToCardInput(block);
    }

    const { title, smartPrefix } = resolveTitleWithSmartPrefix(block, resolvedOptions);

    const childBlocks = Array.isArray(block.children) ? block.children : [];
    const descriptionBlocks = hasInlineTitleContent(block) ? childBlocks : [block];
    const result: CardInput = {
      title,
      description: serializeBlocks(descriptionBlocks),
    };

    if (smartPrefix?.priority) {
      result.priority = smartPrefix.priority;
    }
    if (smartPrefix?.estimate) {
      result.estimate = smartPrefix.estimate;
    }
    if (smartPrefix?.tags.length) {
      result.tags = smartPrefix.tags;
    }

    return result;
  });
}
