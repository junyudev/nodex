import type {
  SidebarSectionItem,
  SidebarSectionItemRef,
  SidebarSectionSummary,
} from "../../shared/sidebar-sections";
import { invokeRendererQuery } from "./renderer-command";

const SIDEBAR_SECTION_PAGE_SIZE = 200;
const MAX_SIDEBAR_SECTION_PAGES = 500;

async function collectKeysetPages<T>(
  readPage: (after: string | null) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor: string | null;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_SIDEBAR_SECTION_PAGES; page += 1) {
    const window = await readPage(after);
    items.push(...window.items);
    if (!window.nextCursor) return items;
    if (window.nextCursor === after) {
      throw new Error("Sidebar Section pagination did not advance");
    }
    after = window.nextCursor;
  }

  throw new Error("Sidebar Section pagination exceeded its safety bound");
}

export function listAllSidebarSections(): Promise<SidebarSectionSummary[]> {
  return collectKeysetPages((after) =>
    invokeRendererQuery("sidebar-sections:list", {
      after,
      first: SIDEBAR_SECTION_PAGE_SIZE,
    }),
  );
}

export function listAllSidebarSectionItems(sectionId: string): Promise<SidebarSectionItem[]> {
  return collectKeysetPages((after) =>
    invokeRendererQuery("sidebar-sections:items:list", sectionId, {
      after,
      first: SIDEBAR_SECTION_PAGE_SIZE,
    }),
  );
}

export function readSidebarSectionItemPlacement(item: SidebarSectionItemRef) {
  return invokeRendererQuery("sidebar-sections:item:placement", item);
}
