import type {
  DatabaseViewField,
  DatabaseViewLayoutDisplayConfig,
} from "../../shared/database-kernel";

export const DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY = "__hidden_property_boundary__";

const propertyField = (propertyId: string): DatabaseViewField => ({
  kind: "property",
  propertyId,
});

const displayedPropertyIds = (display: DatabaseViewLayoutDisplayConfig): ReadonlySet<string> =>
  new Set(display.fields.flatMap((field) => (field.kind === "property" ? [field.propertyId] : [])));

/**
 * Legacy Views know only their displayed fields. Complete them with Source order
 * so every shown and hidden Property has one durable position in this View.
 */
export const normalizedDatabaseViewPropertyOrder = (
  display: DatabaseViewLayoutDisplayConfig,
  activePropertyIds: readonly string[],
): readonly string[] => {
  const active = new Set(activePropertyIds);
  const seen = new Set<string>();
  const order: string[] = [];
  const append = (propertyId: string) => {
    if (!active.has(propertyId) || seen.has(propertyId)) return;
    seen.add(propertyId);
    order.push(propertyId);
  };
  for (const propertyId of display.propertyOrder ?? []) append(propertyId);
  for (const field of display.fields) {
    if (field.kind === "property") append(field.propertyId);
  }
  for (const propertyId of activePropertyIds) append(propertyId);
  return order;
};

export const databaseViewPropertyVisibilityKeys = (
  display: DatabaseViewLayoutDisplayConfig,
  activePropertyIds: readonly string[],
): readonly string[] => {
  const visible = displayedPropertyIds(display);
  const order = normalizedDatabaseViewPropertyOrder(display, activePropertyIds);
  return [
    ...order.filter((propertyId) => visible.has(propertyId)),
    DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
    ...order.filter((propertyId) => !visible.has(propertyId)),
  ];
};

const fieldsWithOrderedProperties = (
  fields: readonly DatabaseViewField[],
  visiblePropertyIds: readonly string[],
): readonly DatabaseViewField[] => {
  let propertyIndex = 0;
  const nextFields = fields.flatMap((field) => {
    if (field.kind !== "property") return [field];
    const propertyId = visiblePropertyIds[propertyIndex++];
    return propertyId ? [propertyField(propertyId)] : [];
  });
  return [...nextFields, ...visiblePropertyIds.slice(propertyIndex).map(propertyField)];
};

/** Applies the same one-list/boundary model used by the visibility rail. */
export const databaseViewDisplayFromPropertyVisibilityKeys = (
  display: DatabaseViewLayoutDisplayConfig,
  keys: readonly string[],
  activePropertyIds: readonly string[],
): DatabaseViewLayoutDisplayConfig => {
  const active = new Set(activePropertyIds);
  const seen = new Set<string>();
  const propertyOrder: string[] = [];
  let boundaryIndex = -1;
  for (const key of keys) {
    if (key === DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY) {
      if (boundaryIndex < 0) boundaryIndex = propertyOrder.length;
      continue;
    }
    if (!active.has(key) || seen.has(key)) continue;
    seen.add(key);
    propertyOrder.push(key);
  }
  for (const propertyId of activePropertyIds) {
    if (seen.has(propertyId)) continue;
    seen.add(propertyId);
    propertyOrder.push(propertyId);
  }
  const visiblePropertyIds = propertyOrder.slice(
    0,
    boundaryIndex < 0 ? propertyOrder.length : boundaryIndex,
  );
  return {
    ...display,
    fields: fieldsWithOrderedProperties(display.fields, visiblePropertyIds),
    propertyOrder,
  };
};

export const toggleDatabaseViewPropertyVisibility = (
  display: DatabaseViewLayoutDisplayConfig,
  activePropertyIds: readonly string[],
  propertyId: string,
  visible: boolean,
): DatabaseViewLayoutDisplayConfig => {
  const keys = databaseViewPropertyVisibilityKeys(display, activePropertyIds).filter(
    (key) => key !== propertyId,
  );
  const boundaryIndex = keys.indexOf(DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY);
  const insertionIndex = visible ? boundaryIndex : boundaryIndex + 1;
  const nextKeys = [...keys];
  nextKeys.splice(insertionIndex, 0, propertyId);
  return databaseViewDisplayFromPropertyVisibilityKeys(display, nextKeys, activePropertyIds);
};

export const moveDatabaseViewProperty = (
  display: DatabaseViewLayoutDisplayConfig,
  activePropertyIds: readonly string[],
  propertyId: string,
  targetKey: string,
  edge: "before" | "after",
): DatabaseViewLayoutDisplayConfig => {
  if (propertyId === targetKey || propertyId === DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY) {
    return display;
  }
  const keys = databaseViewPropertyVisibilityKeys(display, activePropertyIds).filter(
    (key) => key !== propertyId,
  );
  const targetIndex = keys.indexOf(targetKey);
  if (targetIndex < 0) return display;
  const insertionIndex = targetIndex + (edge === "after" ? 1 : 0);
  const nextKeys = [...keys];
  nextKeys.splice(insertionIndex, 0, propertyId);
  return databaseViewDisplayFromPropertyVisibilityKeys(display, nextKeys, activePropertyIds);
};

/** Applies directional insertion semantics for a sortable target. */
export const moveDatabaseViewPropertyToSortableTarget = (
  display: DatabaseViewLayoutDisplayConfig,
  activePropertyIds: readonly string[],
  propertyId: string,
  targetKey: string,
): DatabaseViewLayoutDisplayConfig => {
  const keys = databaseViewPropertyVisibilityKeys(display, activePropertyIds);
  const sourceIndex = keys.indexOf(propertyId);
  const targetIndex = keys.indexOf(targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return display;
  return moveDatabaseViewProperty(
    display,
    activePropertyIds,
    propertyId,
    targetKey,
    sourceIndex < targetIndex ? "after" : "before",
  );
};
