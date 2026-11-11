import { readRelationValuePreview } from "./data-source-relation-value";
import {
  hasPageStageScheduleCapability,
  type PageStageDataSourceProperty,
  type PageStageSemanticProperties,
} from "./page-stage-properties";

/** Typed emptiness for durable Page-layout visibility. Falsy scalar values remain meaningful. */
export const isPageStagePropertyValueEmpty = (item: PageStageDataSourceProperty): boolean => {
  if (item.value === null) return true;
  if (item.property.valueType === "text") return item.value === "";
  if (item.property.valueType === "multi_select") {
    return Array.isArray(item.value) && item.value.length === 0;
  }
  if (item.property.valueType === "relation") {
    return readRelationValuePreview(item.value)?.totalCount === 0;
  }
  return false;
};

export const isPageStagePropertyHiddenByLayout = (item: PageStageDataSourceProperty): boolean =>
  item.pageVisibility === "always_hide" ||
  (item.pageVisibility === "hide_when_empty" && isPageStagePropertyValueEmpty(item));

export const PAGE_STAGE_SCHEDULE_ROW_KEY = "schedule";

/**
 * One row of the Page property list, in Source Page-layout order. A valid schedule pair
 * becomes one composite Schedule row at the position of its first boundary.
 */
export type PageStagePropertyRow =
  | {
      readonly kind: "property";
      readonly key: string;
      readonly item: PageStageDataSourceProperty;
      readonly shownByLayout: boolean;
      /** Nothing to read yet: the row has no value and no error to report. */
      readonly empty: boolean;
    }
  | {
      readonly kind: "schedule";
      readonly key: typeof PAGE_STAGE_SCHEDULE_ROW_KEY;
      readonly shownByLayout: boolean;
      readonly empty: boolean;
    };

const isQuietlyEmpty = (item: PageStageDataSourceProperty): boolean =>
  item.error === null && isPageStagePropertyValueEmpty(item);

export const pageStagePropertyRows = (
  properties: readonly PageStageDataSourceProperty[],
  semantic: PageStageSemanticProperties | null,
): readonly PageStagePropertyRow[] => {
  const schedulePair =
    semantic && hasPageStageScheduleCapability(semantic)
      ? [semantic.scheduledStart?.item, semantic.scheduledEnd?.item].filter(
          (item): item is PageStageDataSourceProperty => item !== undefined,
        )
      : [];
  const schedulePropertyIds = new Set(schedulePair.map((item) => item.property.propertyId));
  const rows: PageStagePropertyRow[] = [];
  let scheduleRowPlaced = false;
  for (const item of properties) {
    if (!schedulePropertyIds.has(item.property.propertyId)) {
      rows.push({
        kind: "property",
        key: item.property.propertyId,
        item,
        shownByLayout: !isPageStagePropertyHiddenByLayout(item),
        empty: isQuietlyEmpty(item),
      });
      continue;
    }
    if (scheduleRowPlaced) continue;
    scheduleRowPlaced = true;
    rows.push({
      kind: "schedule",
      key: PAGE_STAGE_SCHEDULE_ROW_KEY,
      shownByLayout: schedulePair.some((boundary) => !isPageStagePropertyHiddenByLayout(boundary)),
      empty: schedulePair.every(isQuietlyEmpty),
    });
  }
  return rows;
};

/** What the disclosure needs to know about one entry of the list, Property or Page capability. */
export interface PageStagePropertyDisclosureEntry {
  readonly key: string;
  readonly shownByLayout: boolean;
  readonly empty: boolean;
}

/**
 * Where each entry of the Page property list sits while one Page remains mounted.
 *
 * - `shownKeys` are rows of the list. A row the layout shows, or one the person chose, is
 *   promoted and then stays put, so clearing a value never makes its row vanish.
 * - Everything else is tucked behind the disclosure. Opened, a tucked entry that holds a
 *   value is a row (`tuckedRowKeys`) and an empty one is only its name, offered to be chosen.
 *   A tucked row keeps its place until the disclosure closes, whatever happens to its value.
 */
export interface PageStagePropertyDisclosureState {
  readonly pageId: string;
  readonly shownKeys: ReadonlySet<string>;
  readonly tuckedRowKeys: ReadonlySet<string>;
}

const sameKeys = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((key) => right.has(key));

export const advancePageStagePropertyDisclosure = (
  current: PageStagePropertyDisclosureState | null,
  input: {
    readonly pageId: string;
    readonly entries: readonly PageStagePropertyDisclosureEntry[];
    readonly expanded: boolean;
  },
): PageStagePropertyDisclosureState => {
  const previous = current?.pageId === input.pageId ? current : null;
  const heldRows = input.expanded ? (previous?.tuckedRowKeys ?? new Set<string>()) : null;
  const shownKeys = new Set(previous?.shownKeys);
  for (const entry of input.entries) {
    if (entry.shownByLayout && !heldRows?.has(entry.key)) shownKeys.add(entry.key);
  }
  const tuckedRowKeys = new Set<string>();
  if (heldRows) {
    for (const entry of input.entries) {
      if (shownKeys.has(entry.key)) continue;
      if (heldRows.has(entry.key) || !entry.empty) tuckedRowKeys.add(entry.key);
    }
  }
  if (
    previous &&
    sameKeys(previous.shownKeys, shownKeys) &&
    sameKeys(previous.tuckedRowKeys, tuckedRowKeys)
  ) {
    return previous;
  }
  return { pageId: input.pageId, shownKeys, tuckedRowKeys };
};

/** The person chose a tucked-away entry: it joins the list for as long as the Page is mounted. */
export const revealPageStageProperty = (
  current: PageStagePropertyDisclosureState,
  key: string,
): PageStagePropertyDisclosureState => {
  if (current.shownKeys.has(key)) return current;
  const tuckedRowKeys = new Set(current.tuckedRowKeys);
  tuckedRowKeys.delete(key);
  return {
    pageId: current.pageId,
    shownKeys: new Set([...current.shownKeys, key]),
    tuckedRowKeys,
  };
};
