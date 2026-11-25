export type NativeContextMenuIconKey =
  | "pin"
  | "unpin"
  | "rename"
  | "edit"
  | "archive"
  | "unread"
  | "markRead"
  | "snooze"
  | "folder"
  | "folderOpen"
  | "project"
  | "section"
  | "share"
  | "copy"
  | "fork"
  | "local"
  | "openIn"
  | "window"
  | "worktree"
  | "remove"
  | "moveLeft"
  | "moveRight"
  | "moveDown"
  | "close"
  | "newTab"
  | "reload"
  | "duplicate"
  | "trash"
  | "splitLeft"
  | "splitRight"
  | "splitUp"
  | "splitDown";

export interface NativeContextMenuBaseItem {
  id: string;
  label: string;
  enabled?: boolean;
  tooltip?: string;
  accelerator?: string;
  iconKey?: NativeContextMenuIconKey;
  iconUrl?: string;
  nativeRole?: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
}

/**
 * Menus carry no checkbox items: a toggle is an action named for what it does next (Pin / Unpin,
 * Settle / Reopen) with its own icon, so it reads and lines up like its neighbors.
 */
export interface NativeContextMenuActionItem extends NativeContextMenuBaseItem {
  type?: "item";
}

export interface NativeContextMenuSubmenuItem extends NativeContextMenuBaseItem {
  type: "submenu";
  submenu: NativeContextMenuItem[];
}

export interface NativeContextMenuSeparatorItem {
  type: "separator";
  id?: string;
}

export type NativeContextMenuItem =
  | NativeContextMenuActionItem
  | NativeContextMenuSubmenuItem
  | NativeContextMenuSeparatorItem;

export interface NativeContextMenuOptions {
  x?: number;
  y?: number;
  positioningItem?: number;
}
