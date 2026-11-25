import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import {
  ModelPolicySchema,
  sameModelPolicy,
  DEFAULT_MODEL_POLICY,
  type ModelPolicy,
} from "../../../shared/model-policy";
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
import { queryKeys } from "../../lib/query-keys";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import { useAgentRuntimeProviders } from "../../lib/use-agent-runtime-providers";

const queryKey = ["settings", "modelPolicy"] as const;
const updateCommand = defineRendererCommand({
  key: "model_policy_settings.update",
  channel: "settings:model-policy:update",
  authority: "main",
  owner: "model-policy",
  protocol: { kind: "returned_value" },
});

let owners = new WeakMap<QueryClient, LatestReturnedValueOwner<ModelPolicy>>();

/** One Profile preference projection per renderer query owner; Main owns persistence and usage reads. */
export function modelPolicyOwnerFor(queryClient: QueryClient) {
  const existing = owners.get(queryClient);
  if (existing) return existing;
  const owner = createLatestReturnedValueOwner({
    initialValue: DEFAULT_MODEL_POLICY,
    equals: sameModelPolicy,
    operationId: () => createBoundedOperationId("renderer.model-policy.update"),
    project: (_current, desired: ModelPolicy) => desired,
    port: {
      read: async () =>
        ModelPolicySchema.parse(await invokeRendererQuery("settings:model-policy:get")),
      update: async (desired, trace) =>
        ModelPolicySchema.parse(await invokePlainCommandWithTrace(updateCommand, trace, desired)),
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
  const sharedOwner: LatestReturnedValueOwner<ModelPolicy> = {
    ...owner,
    subscribe: (listener) => {
      const unsubscribe = owner.subscribe(() => {
        listener();
        if (refreshRequested && !owner.getSnapshot().pending) refreshCanonical();
      });
      subscriptions += 1;
      if (subscriptions === 1) {
        unsubscribeChanges =
          resolveRendererTransport().subscribeModelPolicyChanges(refreshCanonical);
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

export function useModelPolicy() {
  const queryClient = useQueryClient();
  const owner = modelPolicyOwnerFor(queryClient);
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

export function resetModelPolicyOwnersForTests(): void {
  owners = new WeakMap();
}

async function readModelPolicyCreditWork() {
  const [activity, running] = await Promise.all([
    invokeRendererQuery("agent-runtime:activity:read"),
    invokeRendererQuery("agent-runtime:models:running-credit"),
  ]);
  return {
    runningOnCredit: running.map((run) => ({
      ...run,
      sessionId:
        activity.items.find((item) => item.threadId === run.rootThreadId)?.sessionId ?? null,
    })),
    complete: activity.complete,
  };
}
/** Use the shared provider inventory and join it with live credit work for confirmation. */
export function useModelPolicyCatalog() {
  const client = useQueryClient();
  const {
    data: providers,
    error: providerError,
    isPending: providersPending,
  } = useAgentRuntimeProviders();
  useLayoutEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: queryKeys.agentRuntime.creditWork(), exact: true });
    };
    const transport = resolveRendererTransport();
    const unsubPolicy = transport.subscribeModelPolicyChanges(refresh);
    const unsubActivity = transport.subscribeAgentRuntimeActivityChanges?.(refresh);
    return () => {
      unsubPolicy();
      unsubActivity?.();
    };
  }, [client]);
  const {
    data: creditWork,
    error: creditWorkError,
    isPending: creditWorkPending,
  } = useQuery({
    queryKey: queryKeys.agentRuntime.creditWork(),
    queryFn: readModelPolicyCreditWork,
    retry: false,
    staleTime: 0,
  });
  const data = useMemo(
    () => (providers && creditWork ? { providers, ...creditWork } : undefined),
    [providers, creditWork],
  );
  return {
    data,
    error: providerError ?? creditWorkError,
    isPending: providersPending || creditWorkPending,
  };
}
