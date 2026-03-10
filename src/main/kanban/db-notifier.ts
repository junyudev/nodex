import { EventEmitter } from "events";

export type ChangeType = "create" | "update" | "delete" | "move" | "undo" | "redo" | "revert" | "restore";

export interface BoardChangeEvent {
  projectId: string;
  changeType: ChangeType;
  columnId: string;
  cardId?: string;
}

class DatabaseNotifier extends EventEmitter {
  constructor() {
    super();
    // Each SSE connection adds a listener; disable the default cap
    // since listeners are properly removed on disconnect.
    this.setMaxListeners(0);
  }

  notifyChange(projectId: string, changeType: ChangeType, columnId: string, cardId?: string): void {
    this.emit("board-changed", { projectId, changeType, columnId, cardId });
  }
}

export const dbNotifier = new DatabaseNotifier();
