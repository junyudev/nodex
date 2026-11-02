import type { Menu, MenuItem } from "electron";
import type { ApplicationMenuEntry, ApplicationMenuSnapshot } from "../shared/application-menu";

/** Keeps native handles private and revokes commands whenever a window takes a new snapshot. */
export class ApplicationMenuSnapshots {
  private revision = 0;
  private readonly windows = new Map<number, Map<string, readonly MenuItem[]>>();

  read(windowId: number, menu: Menu | null): ApplicationMenuSnapshot {
    const commands = new Map<string, readonly MenuItem[]>();
    this.windows.set(windowId, commands);
    const revision = ++this.revision;
    const project = (
      items: readonly MenuItem[],
      parents: readonly MenuItem[] = [],
    ): ApplicationMenuEntry[] =>
      items
        .filter((item) => item.visible)
        .map((item, index) => {
          const id = `${revision}:${commands.size}:${index}`;
          const ancestry = [...parents, item];
          commands.set(id, ancestry);
          if (item.type === "separator") return { type: "separator", id };
          const common = {
            id,
            label: item.label.replace(/&/g, ""),
            enabled: ancestry.every((parent) => parent.enabled),
          };
          if (item.submenu)
            return { ...common, type: "submenu", items: project(item.submenu.items, ancestry) };
          return {
            ...common,
            type: item.type === "checkbox" || item.type === "radio" ? item.type : "item",
            checked: item.checked,
            ...(item.accelerator ? { accelerator: item.accelerator } : {}),
          };
        });
    return {
      menus: project(menu?.items ?? []).filter(
        (item): item is Extract<ApplicationMenuEntry, { type: "submenu" }> =>
          item.type === "submenu",
      ),
    };
  }

  resolve(windowId: number, id: string): MenuItem | null {
    const ancestry = this.windows.get(windowId)?.get(id);
    if (!ancestry?.every((item) => item.visible && item.enabled)) return null;
    const item = ancestry.at(-1);
    if (!item || item.submenu || item.type === "separator") return null;
    return item;
  }

  release(windowId: number): void {
    this.windows.delete(windowId);
  }
  clear(): void {
    this.windows.clear();
  }
}

/** Native-only accelerators still work after Windows removes its per-window menu surface. */
export function findNativeMenuAccelerator(
  menu: Menu | null,
  matches: (accelerator: string) => boolean,
): MenuItem | null {
  for (const item of menu?.items ?? []) {
    if (!item.enabled || !item.visible) continue;
    if (item.submenu) {
      const found = findNativeMenuAccelerator(item.submenu, matches);
      if (found) return found;
      continue;
    }
    const isNative =
      Boolean(item.role) || ["view.resetZoom", "view.zoomIn", "view.zoomOut"].includes(item.id);
    if (isNative && item.accelerator && matches(item.accelerator)) return item;
  }
  return null;
}
