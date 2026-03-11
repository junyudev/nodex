interface SidebarSectionLikeItem {
  id: string;
  active?: boolean;
}

interface SidebarSectionLike<Item extends SidebarSectionLikeItem> {
  id: string;
  items: Item[];
  collapsible?: boolean;
}

export interface SidebarSectionRenderState<Item extends SidebarSectionLikeItem> {
  expanded: boolean;
  visibleItems: Item[];
  overflowItems: Item[];
  pinnedItems: Item[];
  hasOverflow: boolean;
}

export function resolveStageSidebarSectionRenderState<Item extends SidebarSectionLikeItem>(
  section: SidebarSectionLike<Item>,
  expandedSections: Record<string, boolean>,
  showAllItemsBySection: Record<string, boolean>,
  collapseLimit = 10,
): SidebarSectionRenderState<Item> {
  const expanded = section.collapsible ? (expandedSections[section.id] ?? false) : true;
  if (!expanded) {
    return {
      expanded,
      visibleItems: [],
      overflowItems: [],
      pinnedItems: section.items.filter((item) => item.active),
      hasOverflow: false,
    };
  }

  const showAllItems = showAllItemsBySection[section.id] ?? false;
  const hasOverflow = section.items.length > collapseLimit;
  if (!hasOverflow || showAllItems) {
    return {
      expanded,
      visibleItems: section.items,
      overflowItems: [],
      pinnedItems: [],
      hasOverflow,
    };
  }

  return {
    expanded,
    visibleItems: section.items.slice(0, collapseLimit),
    overflowItems: section.items.slice(collapseLimit),
    pinnedItems: [],
    hasOverflow,
  };
}
