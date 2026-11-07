export function mergeOrderedStringIds(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return upsertOrderedStringIds(existing, incoming);
}

export function upsertOrderedStringIds(
  existing: readonly string[],
  ids: readonly string[],
): string[] {
  const merged = [...existing];
  const seen = new Set(existing);

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }

  return merged;
}

export function insertOrderedStringIdsAfter(
  existing: readonly string[],
  anchorId: string | null,
  ids: readonly string[],
): string[] {
  const insertIds = upsertOrderedStringIds([], ids);
  if (insertIds.length === 0) return [...existing];

  const insertSet = new Set(insertIds);
  const withoutInsertedIds = existing.filter((id) => !insertSet.has(id));
  const anchorIndex = anchorId ? withoutInsertedIds.indexOf(anchorId) : -1;
  const insertionIndex = anchorIndex >= 0 ? anchorIndex + 1 : withoutInsertedIds.length;

  return [
    ...withoutInsertedIds.slice(0, insertionIndex),
    ...insertIds,
    ...withoutInsertedIds.slice(insertionIndex),
  ];
}

export function removeOrderedStringIds(
  existing: readonly string[],
  ids: readonly string[],
): string[] {
  if (ids.length === 0) return [...existing];
  const idsToRemove = new Set(ids);
  return existing.filter((id) => !idsToRemove.has(id));
}
