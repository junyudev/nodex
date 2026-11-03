import { observeMainSettings } from "./observe-main-settings";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  LinkOpeningSettingsSchema,
  sameLinkOpeningSettings,
  DEFAULT_LINK_OPENING_SETTINGS,
  type LinkOpeningSettings,
} from "../../shared/link-opening-settings";
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

const queryKey = ["settings", "linkOpening"] as const;
const updateCommand = defineRendererCommand({
  key: "link_opening_settings.update",
  channel: "settings:link-opening:update",
  authority: "main",
  owner: "link-opening-settings",
  protocol: { kind: "returned_value" },
});

let owners = new WeakMap<QueryClient, LatestReturnedValueOwner<LinkOpeningSettings>>();

/** One Profile preference projection per renderer query owner; Main owns persistence and link-routing reads. */
export function linkOpeningSettingsOwnerFor(queryClient: QueryClient) {
  const existing = owners.get(queryClient);
  if (existing) return existing;
  const owner = createLatestReturnedValueOwner({
    initialValue: DEFAULT_LINK_OPENING_SETTINGS,
    equals: sameLinkOpeningSettings,
    operationId: () => createBoundedOperationId("renderer.link-opening-settings.update"),
    project: (_current, desired: LinkOpeningSettings) => desired,
    port: {
      read: async () =>
        LinkOpeningSettingsSchema.parse(await invokeRendererQuery("settings:link-opening:get")),
      update: async (desired, trace) =>
        LinkOpeningSettingsSchema.parse(
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
      resolveRendererTransport().subscribeLinkOpeningSettingsChanges?.(listener) ?? (() => {}),
  );
  owners.set(queryClient, sharedOwner);
  return sharedOwner;
}

export function useLinkOpeningSettings() {
  const queryClient = useQueryClient();
  const owner = linkOpeningSettingsOwnerFor(queryClient);
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

export function resetLinkOpeningSettingsOwnersForTests(): void {
  owners = new WeakMap();
}
