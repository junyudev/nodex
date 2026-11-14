/** An insert catalog entry as far as grouping cares: where it belongs and what it is. */
interface GroupableInsertItem {
  readonly key: string;
  readonly group: string;
}

export interface PageInsertSection<Item> {
  readonly label: string;
  readonly items: readonly Item[];
}

/**
 * The Page toolbar's Insert menu leads with what makes a Page more than text: work for an Agent,
 * then other Pages, then Blocks. Catalog groups it does not know keep their catalog order after.
 */
const SECTION_ORDER: readonly string[] = ["Agent", "Pages", "Blocks"];

/** Inline insertions sit in the catalog's Text group beside the line styles the toolbar owns. */
const SECTION_LABEL_BY_GROUP: Readonly<Record<string, string>> = { Text: "Inline" };

/**
 * Sections of the Insert menu from the body's insert catalog. Entries the toolbar already offers
 * as a line style are left out, and a section left empty is dropped.
 */
export function groupPageInsertItems<Item extends GroupableInsertItem>(
  items: readonly Item[],
  excludedKeys: ReadonlySet<string>,
): readonly PageInsertSection<Item>[] {
  const itemsByGroup = new Map<string, Item[]>();
  for (const item of items) {
    if (excludedKeys.has(item.key)) continue;
    const group = itemsByGroup.get(item.group);
    if (group) group.push(item);
    else itemsByGroup.set(item.group, [item]);
  }
  const groups = [
    ...SECTION_ORDER.filter((group) => itemsByGroup.has(group)),
    ...[...itemsByGroup.keys()].filter((group) => !SECTION_ORDER.includes(group)),
  ];
  return groups.map((group) => ({
    label: SECTION_LABEL_BY_GROUP[group] ?? group,
    items: itemsByGroup.get(group) ?? [],
  }));
}
