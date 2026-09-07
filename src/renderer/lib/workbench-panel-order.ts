/** Applies explicit mixed presentation order without hiding newly opened or unlisted tabs. */
export function orderWorkbenchPanelTabs<Tab extends { readonly id: string }>(
  tabs: readonly Tab[],
  order?: readonly string[],
): Tab[] {
  if (!order) return [...tabs];
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = order.flatMap((id) => {
    const tab = byId.get(id);
    if (!tab) return [];
    byId.delete(id);
    return [tab];
  });
  return [...ordered, ...byId.values()];
}
