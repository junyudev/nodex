export interface AppShellTabLocationEntry {
  readonly id: string;
  readonly title: string;
  /** Where the tab's content lives, outermost first. */
  readonly location?: readonly string[];
}

const suffix = (location: readonly string[], length: number) =>
  location.slice(Math.max(0, location.length - length)).join("/");

/**
 * The location each tab shows beside its title. A tab shows one only when another tab in the
 * strip has the same title and a different location, and then only the fewest trailing parts
 * that tell it apart from those tabs: `index.ts lib` beside `index.ts main/lib`.
 */
export function resolveAppShellTabLocationDetails(
  tabs: readonly AppShellTabLocationEntry[],
): ReadonlyMap<string, string> {
  const byTitle = new Map<string, AppShellTabLocationEntry[]>();
  for (const tab of tabs) {
    if (!tab.location?.length) continue;
    const title = tab.title.trim();
    byTitle.set(title, [...(byTitle.get(title) ?? []), tab]);
  }

  const details = new Map<string, string>();
  for (const group of byTitle.values()) {
    for (const tab of group) {
      const location = tab.location ?? [];
      const others = group.filter(
        (other) =>
          other !== tab && suffix(other.location ?? [], Infinity) !== suffix(location, Infinity),
      );
      if (others.length === 0) continue;
      for (let length = 1; length <= location.length; length += 1) {
        const detail = suffix(location, length);
        if (others.some((other) => suffix(other.location ?? [], length) === detail)) continue;
        details.set(tab.id, detail);
        break;
      }
      if (!details.has(tab.id)) details.set(tab.id, suffix(location, Infinity));
    }
  }
  return details;
}
