export type NativeContextMenuIconKey =
  | "pin"
  | "unpin"
  | "rename"
  | "edit"
  | "archive"
  | "unread"
  | "markRead"
  | "folder"
  | "folderOpen"
  | "project"
  | "section"
  | "share"
  | "copy"
  | "fork"
  | "openIn"
  | "window"
  | "worktree"
  | "remove";

export interface NativeContextMenuBaseItem {
  id: string;
  label: string;
  enabled?: boolean;
  tooltip?: string;
  accelerator?: string;
  iconKey?: NativeContextMenuIconKey;
  iconUrl?: string;
}

export interface NativeContextMenuActionItem extends NativeContextMenuBaseItem {
  type?: "item";
}

export interface NativeContextMenuCheckboxItem extends NativeContextMenuBaseItem {
  type: "checkbox";
  checked?: boolean;
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
  | NativeContextMenuCheckboxItem
  | NativeContextMenuSubmenuItem
  | NativeContextMenuSeparatorItem;

export interface NativeContextMenuOptions {
  x?: number;
  y?: number;
  positioningItem?: number;
}
