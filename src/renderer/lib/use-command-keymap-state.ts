import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { subscribeCommandKeymapChanges } from "./api";
import { queryKeys } from "./query-keys";
import { commandKeymapStateQueryOptions } from "./query-options";
import {
  createCommandKeymapState,
  formatCommandShortcutLabel,
  type CommandId,
  type CommandKeybindingUpdate,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import { resolveCodexRendererCommandPlatform } from "./codex-window-runtime";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

const updateCommandKeybindingCommand = defineRendererCommand({
  key: "command_keymap.update_binding",
  channel: "set-codex-command-keybinding",
  authority: "main",
  owner: "CommandKeymap",
  protocol: { kind: "returned_value" },
});

const resetCommandKeybindingsCommand = defineRendererCommand({
  key: "command_keymap.reset_bindings",
  channel: "reset-codex-command-keybindings",
  authority: "main",
  owner: "CommandKeymap",
  protocol: { kind: "returned_value" },
});

export function updateCommandKeybinding(commandId: string, update: CommandKeybindingUpdate) {
  return invokePlainCommand(updateCommandKeybindingCommand, commandId, update);
}

export function resetCommandKeybindings() {
  return invokePlainCommand(resetCommandKeybindingsCommand);
}

export function useCommandKeymapState() {
  const queryClient = useQueryClient();
  const query = useQuery(commandKeymapStateQueryOptions());

  useEffect(() => {
    return subscribeCommandKeymapChanges((state: CommandKeymapState) => {
      queryClient.setQueryData(queryKeys.settings.commandKeymap(), state);
    });
  }, [queryClient]);

  return query;
}

/** Browser-safe platform defaults apply until the persisted keymap arrives. */
export function useResolvedCommandKeymapState(): CommandKeymapState {
  return (
    useCommandKeymapState().data ??
    createCommandKeymapState({}, resolveCodexRendererCommandPlatform())
  );
}

/** The current platform label, or undefined when the command is unassigned. */
export function useCommandShortcutLabel(commandId: CommandId): string | undefined {
  return formatCommandShortcutLabel(useResolvedCommandKeymapState(), commandId);
}
