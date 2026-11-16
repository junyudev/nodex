export interface NfmHeadingNavigationItem {
  id: string;
  ordinal: number;
  label: string;
  level: 1 | 2 | 3 | 4;
  depth: number;
}

export interface NfmHeadingNavigationBlockLike {
  id?: string;
  type?: string;
  props?: {
    level?: unknown;
  };
  content?: unknown;
  children?: NfmHeadingNavigationBlockLike[];
}

export const MIN_NFM_HEADING_NAVIGATION_ITEMS = 4;

function extractInlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item !== "object" || item === null) return "";

      const candidate = item as {
        text?: unknown;
        content?: unknown;
      };
      if (typeof candidate.text === "string") return candidate.text;
      return extractInlineText(candidate.content);
    })
    .join("");
}

function normalizeHeadingLevel(value: unknown): 1 | 2 | 3 | 4 {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  if (value <= 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  return 4;
}

export function collectNfmHeadingNavigationItems(
  blocks: readonly NfmHeadingNavigationBlockLike[],
  untitled = "Untitled",
): NfmHeadingNavigationItem[] {
  const items: NfmHeadingNavigationItem[] = [];

  function visit(block: NfmHeadingNavigationBlockLike): void {
    if (block.type === "heading" && typeof block.id === "string" && block.id.length > 0) {
      const level = normalizeHeadingLevel(block.props?.level);
      const label = extractInlineText(block.content).replace(/\s+/g, " ").trim() || untitled;
      items.push({
        id: block.id,
        ordinal: items.length + 1,
        label,
        level,
        depth: level - 1,
      });
    }

    for (const child of block.children ?? []) {
      visit(child);
    }
  }

  for (const block of blocks) {
    visit(block);
  }

  return items;
}

export function isNfmHeadingNavigationEligible(input: {
  itemCount: number;
  isActivePanelTab: boolean;
  isRawContent: boolean;
  isCoarsePointer: boolean;
}): boolean {
  if (!input.isActivePanelTab) return false;
  if (input.isRawContent) return false;
  if (input.isCoarsePointer) return false;
  return input.itemCount >= MIN_NFM_HEADING_NAVIGATION_ITEMS;
}
