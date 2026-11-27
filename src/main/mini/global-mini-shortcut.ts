import { globalShortcut } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areOsGlobalShortcutsEqual,
  findCommandKeybindingConflict,
  getCommandEntry,
  getPrimaryCommandAccelerator,
  toElectronAccelerator,
  type CommandKeybindingRejection,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import {
  acquireDesktopShortcutOwnership,
  type DesktopShortcutOwnershipLease,
} from "../dictation/global-dictation-ownership-lock";

const commandId = "openMini";
const unavailable = (message: string): CommandKeybindingRejection => ({
  kind: "shortcut-unavailable",
  message,
});

/** Electron and the machine-wide lease both have to admit the configured chord. */
export class GlobalMiniShortcut {
  #lease: DesktopShortcutOwnershipLease | null = null;
  #registered: string | undefined;
  #issue: CommandKeybindingRejection | null = null;

  constructor(private readonly onShortcut: () => void) {}

  #loseOwnership = (): void => {
    this.dispose();
    this.#issue = unavailable("Another Nodex instance owns the Mini shortcut.");
  };

  sync(state: CommandKeymapState): CommandKeybindingRejection | null {
    const key = getCommandEntry(state, commandId)?.available
      ? getPrimaryCommandAccelerator(state, commandId)
      : null;
    if (!key) {
      this.dispose();
      return null;
    }

    // A hand-edited settings file can bypass the interactive keymap validator.
    const conflict = findCommandKeybindingConflict(state, commandId, key);
    if (conflict) {
      return this.#reject({
        kind: "conflict",
        message: `Keyboard shortcut already used by ${conflict.commandTitle}`,
        conflictingCommandId: conflict.commandId,
        conflictingCommandTitle: conflict.commandTitle,
      });
    }

    if (
      this.#registered &&
      this.#lease?.isOwner() &&
      areOsGlobalShortcutsEqual(this.#registered, key, state.platform)
    ) {
      this.#issue = null;
      return null;
    }
    if (this.#lease && !this.#lease.isOwner()) this.dispose();
    this.#lease ??= acquireDesktopShortcutOwnership(
      join(tmpdir(), "nodex-open-mini.lock"),
      this.#loseOwnership,
    );
    if (!this.#lease) {
      return this.#reject(unavailable("Another Nodex instance owns the Mini shortcut."));
    }

    const accelerator = toElectronAccelerator(key);
    if (!accelerator || !this.#register(accelerator)) {
      return this.#reject(unavailable("The Mini shortcut is already in use or unavailable."));
    }
    if (this.#registered) globalShortcut.unregister(this.#registered);
    this.#registered = accelerator;
    this.#issue = null;
    return null;
  }

  #register(accelerator: string): boolean {
    try {
      return globalShortcut.register(accelerator, this.#onPressed);
    } catch {
      // Electron can reject an accelerator that it cannot express on the current platform.
      return false;
    }
  }

  #onPressed = (): void => {
    if (this.#lease?.isOwner()) this.onShortcut();
  };

  #reject(issue: CommandKeybindingRejection): CommandKeybindingRejection {
    // Keep the previous registration while the settings transaction rejects the edit.
    if (!this.#registered) {
      this.dispose();
      this.#issue = issue;
    }
    return issue;
  }

  decorate(state: CommandKeymapState): CommandKeymapState {
    const issue = this.#issue;
    if (!issue) return state;
    return {
      ...state,
      entries: state.entries.map((entry) =>
        entry.id === commandId ? { ...entry, registrationIssue: issue } : entry,
      ),
    };
  }

  dispose(): void {
    if (this.#registered) globalShortcut.unregister(this.#registered);
    this.#registered = undefined;
    this.#lease?.dispose();
    this.#lease = null;
    this.#issue = null;
  }
}
