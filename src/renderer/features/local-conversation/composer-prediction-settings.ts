import { observeMainSettings } from "../../lib/observe-main-settings";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  ComposerPredictionSettingsSchema,
  DEFAULT_COMPOSER_PREDICTION_SETTINGS,
  type ComposerPredictionSettings,
} from "../../../shared/composer-prediction-settings";
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

const queryKey = ["settings", "composerPredictions"] as const;
const updateCommand = defineRendererCommand({
  key: "composer_predictions_settings.update",
  channel: "settings:composer-predictions:update",
  authority: "main",
  owner: "composer-prediction-settings",
  protocol: { kind: "returned_value" },
});

let owners = new WeakMap<QueryClient, LatestReturnedValueOwner<ComposerPredictionSettings>>();

/** One Profile preference projection per renderer query owner; Main owns persistence and inference. */
export function composerPredictionSettingsOwnerFor(queryClient: QueryClient) {
  const existing = owners.get(queryClient);
  if (existing) return existing;
  const owner = createLatestReturnedValueOwner({
    initialValue: DEFAULT_COMPOSER_PREDICTION_SETTINGS,
    equals: (left, right) => left.enabled === right.enabled,
    operationId: () => createBoundedOperationId("renderer.composer-prediction-settings.update"),
    project: (_current, desired: ComposerPredictionSettings) => desired,
    port: {
      read: async () =>
        ComposerPredictionSettingsSchema.parse(
          await invokeRendererQuery("settings:composer-predictions:get"),
        ),
      update: async (desired, trace) =>
        ComposerPredictionSettingsSchema.parse(
          await invokePlainCommandWithTrace(updateCommand, trace, desired),
        ),
    },
    semanticKey: updateCommand.key,
    owner: updateCommand.owner,
    scopeKind: "application",
  });
  const sharedOwner = observeMainSettings(owner, queryClient, queryKey, (listener) =>
    resolveRendererTransport().subscribeComposerPredictionSettingsChanges(listener),
  );
  owners.set(queryClient, sharedOwner);
  return sharedOwner;
}

export function useComposerPredictionSettings() {
  const queryClient = useQueryClient();
  const owner = composerPredictionSettingsOwnerFor(queryClient);
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

export function resetComposerPredictionSettingsOwnersForTests(): void {
  owners = new WeakMap();
}
