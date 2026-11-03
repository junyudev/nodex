import { observeMainSettings } from "./observe-main-settings";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  TerminalShellSettingsSchema,
  DEFAULT_TERMINAL_SHELL_SETTINGS,
  type TerminalShellSettings,
} from "../../shared/terminal-shell-settings";
import { createBoundedOperationId } from "../../shared/operation-identity";
import {
  createLatestReturnedValueOwner,
  type LatestReturnedValueOwner,
} from "./latest-returned-value-owner";
import {
  defineRendererCommand,
  invokePlainCommandWithTrace,
  invokeRendererQuery,
} from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const queryKey = ["settings", "terminalShell"] as const;
const updateCommand = defineRendererCommand({
  key: "terminal_shell_settings.update",
  channel: "settings:terminal-shell:update",
  authority: "main",
  owner: "terminal-shell-settings",
  protocol: { kind: "returned_value" },
});

let owners = new WeakMap<QueryClient, LatestReturnedValueOwner<TerminalShellSettings>>();

/** One Profile preference projection per renderer query owner; Main owns persistence and terminal launches. */
export function terminalShellSettingsOwnerFor(queryClient: QueryClient) {
  const existing = owners.get(queryClient);
  if (existing) return existing;
  const owner = createLatestReturnedValueOwner({
    initialValue: DEFAULT_TERMINAL_SHELL_SETTINGS,
    equals: (left, right) => left.windowsShell === right.windowsShell,
    operationId: () => createBoundedOperationId("renderer.terminal-shell-settings.update"),
    project: (_current, desired: TerminalShellSettings) => desired,
    port: {
      read: async () =>
        TerminalShellSettingsSchema.parse(await invokeRendererQuery("settings:terminal-shell:get")),
      update: async (desired, trace) =>
        TerminalShellSettingsSchema.parse(
          await invokePlainCommandWithTrace(updateCommand, trace, desired),
        ),
    },
    semanticKey: updateCommand.key,
    owner: updateCommand.owner,
    scopeKind: "application",
  });
  const sharedOwner = observeMainSettings(
    owner,
    queryClient,
    queryKey,
    (listener) =>
      resolveRendererTransport().subscribeTerminalShellSettingsChanges?.(listener) ?? (() => {}),
  );
  owners.set(queryClient, sharedOwner);
  return sharedOwner;
}

export function useTerminalShellSettings() {
  const queryClient = useQueryClient();
  const owner = terminalShellSettingsOwnerFor(queryClient);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const query = useQuery({
    queryKey,
    queryFn: owner.readCanonical,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
  useLayoutEffect(() => {
    if (snapshot.renderToken !== null) owner.markRendered(snapshot.renderToken);
  }, [owner, snapshot.renderToken]);
  return {
    settings: snapshot.value,
    isLoading: query.isPending,
    isSaving: snapshot.pending,
    error: query.error,
    updateSettings: owner.update,
  };
}

export function resetTerminalShellSettingsOwnersForTests(): void {
  owners = new WeakMap();
}
