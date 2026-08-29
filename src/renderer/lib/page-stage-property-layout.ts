import { readRelationValuePreview } from "./data-source-relation-value";
import type { PageStageDataSourceProperty } from "./page-stage-properties";

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
