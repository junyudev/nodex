import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  UsageMeterSettingsSchema,
  sameUsageMeterSettings,
  DEFAULT_USAGE_METER_SETTINGS,
  type UsageMeterSettings,
} from "../../../shared/usage-meter-settings";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import {
  createLatestReturnedValueOwner,
  type LatestReturnedValueOwner,
} from "../../lib/latest-returned-value-owner";
import {
  defineRendererCommand,
  invokePlainCommandWithTrace,
  invokeRendererQuery,
} from "../../lib/renderer-command";
import { resolveRendererTransport } from "../../lib/renderer-transport";

const queryKey = ["settings", "usageMeters"] as const;
const updateCommand = defineRendererCommand({
  key: "usage_meters_settings.update",
  channel: "settings:usage-meters:update",
  authority: "main",
  owner: "usage-meter-settings",
  protocol: { kind: "returned_value" },
});

let owners = new WeakMap<QueryClient, LatestReturnedValueOwner<UsageMeterSettings>>();

/** One Profile preference projection per renderer query owner; Main owns persistence and usage reads. */
export function usageMeterSettingsOwnerFor(queryClient: QueryClient) {
  const existing = owners.get(queryClient);
  if (existing) return existing;
  const owner = createLatestReturnedValueOwner({
    initialValue: DEFAULT_USAGE_METER_SETTINGS,
    equals: sameUsageMeterSettings,
    operationId: () => createBoundedOperationId("renderer.usage-meter-settings.update"),
    project: (_current, desired: UsageMeterSettings) => desired,
    port: {
      read: async () =>
        UsageMeterSettingsSchema.parse(await invokeRendererQuery("settings:usage-meters:get")),
      update: async (desired, trace) =>
        UsageMeterSettingsSchema.parse(
          await invokePlainCommandWithTrace(updateCommand, trace, desired),
        ),
    },
    semanticKey: updateCommand.key,
    owner: updateCommand.owner,
    scopeKind: "application",
  });
  let subscriptions = 0;
  let unsubscribeChanges: (() => void) | null = null;
  let refreshRequested = false;
  let refreshSequence = 0;
  const refreshCanonical = () => {
    refreshRequested = true;
    if (owner.getSnapshot().pending) return;
    refreshRequested = false;
    const sequence = ++refreshSequence;
    // Notifications and command replies have independent delivery order. Read Main's
    // current value instead of treating a delayed notification as a newer mutation.
    void queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
      if (sequence !== refreshSequence) return;
      if (owner.getSnapshot().pending) {
        refreshRequested = true;
        return;
      }
      return queryClient.invalidateQueries({ queryKey, exact: true });
    });
  };
  const sharedOwner: LatestReturnedValueOwner<UsageMeterSettings> = {
    ...owner,
    subscribe: (listener) => {
      const unsubscribe = owner.subscribe(() => {
        listener();
        if (refreshRequested && !owner.getSnapshot().pending) refreshCanonical();
      });
      subscriptions += 1;
      if (subscriptions === 1) {
        unsubscribeChanges =
          resolveRendererTransport().subscribeUsageMeterSettingsChanges(refreshCanonical);
      }
      return () => {
        unsubscribe();
        subscriptions -= 1;
        if (subscriptions > 0) return;
        unsubscribeChanges?.();
        unsubscribeChanges = null;
      };
    },
  };
  owners.set(queryClient, sharedOwner);
  return sharedOwner;
}

export function useUsageMeterSettings() {
  const queryClient = useQueryClient();
  const owner = usageMeterSettingsOwnerFor(queryClient);
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

export function resetUsageMeterSettingsOwnersForTests(): void {
  owners = new WeakMap();
}
