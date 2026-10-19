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
    }
  | {
      readonly kind: "schedule";
      readonly key: typeof PAGE_STAGE_SCHEDULE_ROW_KEY;
      readonly shownByLayout: boolean;
    };

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
      });
      continue;
    }
    if (scheduleRowPlaced) continue;
    scheduleRowPlaced = true;
    rows.push({
      kind: "schedule",
      key: PAGE_STAGE_SCHEDULE_ROW_KEY,
      shownByLayout: schedulePair.some((boundary) => !isPageStagePropertyHiddenByLayout(boundary)),
    });
  }
  return rows;
};

/**
 * Which rows stay outside the disclosure while one Page remains mounted. A row the layout
 * shows is promoted and then stays put, so clearing a value never makes its row vanish.
 * While the disclosure is open, membership is frozen: filling a tucked-away row keeps it in
 * place until the disclosure closes.
 */
export interface PageStagePropertyDisclosureState {
  readonly pageId: string;
  readonly shownKeys: ReadonlySet<string>;
}

export const advancePageStagePropertyDisclosure = (
  current: PageStagePropertyDisclosureState | null,
  input: {
    readonly pageId: string;
    readonly rows: readonly Pick<PageStagePropertyRow, "key" | "shownByLayout">[];
    readonly expanded: boolean;
  },
): PageStagePropertyDisclosureState => {
  const shownByLayout = input.rows.filter((row) => row.shownByLayout).map((row) => row.key);
  if (!current || current.pageId !== input.pageId) {
    return { pageId: input.pageId, shownKeys: new Set(shownByLayout) };
  }
  if (input.expanded) return current;
  const promoted = shownByLayout.filter((key) => !current.shownKeys.has(key));
  if (promoted.length === 0) return current;
  return { pageId: current.pageId, shownKeys: new Set([...current.shownKeys, ...promoted]) };
};
