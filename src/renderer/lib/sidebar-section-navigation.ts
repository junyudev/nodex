import type { SidebarSectionItem } from "../../shared/sidebar-sections";

/**
 * The chats the reader's Sections show in the Project tree, in Section and placement order, so
 * moving from chat to chat reaches them where they sit. A folded Section shows none, a settled
 * chat has left for the Settled shelf, and a Project placed in a Section brings the chats it
 * shows beneath it.
 */
export function sidebarSectionChatIds(input: {
  readonly sectionIds: readonly string[];
  readonly itemsBySectionId: ReadonlyMap<string, readonly SidebarSectionItem[]>;
  readonly collapsed: (sectionId: string) => boolean;
  readonly projectChatIds: (projectId: string) => readonly string[];
}): readonly string[] {
  return input.sectionIds.flatMap((sectionId) =>
    input.collapsed(sectionId)
      ? []
      : (input.itemsBySectionId.get(sectionId) ?? []).flatMap((item) => {
          if (item.kind === "project") return input.projectChatIds(item.project.projectId);
          return item.session.settledAt == null ? [item.session.id] : [];
        }),
  );
}
