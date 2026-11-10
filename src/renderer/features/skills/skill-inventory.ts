import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { SkillId, SkillInput, SkillInventoryContext } from "../../../shared/skill-inventory";
import {
  skillInventoryAdapter,
  subscribeSkillChanges,
  subscribeSkillScopeChanges,
} from "@/lib/skill-inventory-adapter";
import { spaceQueryKey } from "@/lib/renderer-space";

const contextKey = ({ hostId, projectId }: SkillInventoryContext) =>
  spaceQueryKey(["skillInventory", hostId, projectId] as const);
const documentKey = (context: SkillInventoryContext, skillId: SkillId | null) =>
  [...contextKey(context), "document", skillId] as const;
const inventoryKey = (context: SkillInventoryContext) =>
  [...contextKey(context), "locations"] as const;

function useSkillWatch(context: SkillInventoryContext, skillId?: SkillId) {
  const { hostId, projectId } = context;
  const client = useQueryClient();
  useEffect(() => {
    let generation = 0;
    let subscriptionId: string | undefined;
    const input = { hostId, projectId };
    const reconcile = () => {
      void client.invalidateQueries({
        queryKey: skillId ? documentKey(input, skillId) : inventoryKey(input),
      });
    };
    const unsubscribe = subscribeSkillChanges((event) => {
      if (event.subscriptionId === subscriptionId) reconcile();
    });
    const stop = (id: string) => {
      void skillInventoryAdapter.watchStop({ subscriptionId: id }).catch(() => {});
    };
    const start = () => {
      const current = ++generation;
      if (subscriptionId) stop(subscriptionId);
      subscriptionId = undefined;
      void skillInventoryAdapter
        .watchStart({ ...input, ...(skillId ? { skillId } : {}) })
        .then((result) => {
          if (result.status !== "ok") return;
          if (current !== generation) {
            stop(result.value.subscriptionId);
            return;
          }
          subscriptionId = result.value.subscriptionId;
          reconcile();
        })
        .catch(() => {});
    };
    const unsubscribeScope = subscribeSkillScopeChanges(projectId, () => {
      reconcile();
      start();
    });
    start();
    return () => {
      generation += 1;
      unsubscribe?.();
      unsubscribeScope();
      if (subscriptionId) stop(subscriptionId);
    };
  }, [client, hostId, projectId, skillId]);
}

export function useSkillInventory(context: SkillInventoryContext) {
  useSkillWatch(context);
  return useQuery({
    queryKey: inventoryKey(context),
    queryFn: () => skillInventoryAdapter.list({ ...context, forceRefresh: true }),
    refetchOnWindowFocus: true,
  });
}

export function useSkillDocument(context: SkillInventoryContext, skillId: SkillId) {
  useSkillWatch(context, skillId);
  return useQuery({
    queryKey: documentKey(context, skillId),
    queryFn: () => skillInventoryAdapter.readDocument({ ...context, skillId }),
    refetchOnWindowFocus: true,
  });
}

function skillCommands(client: QueryClient, context: SkillInventoryContext) {
  const invalidate = async <Result>(result: Promise<Result>) => {
    try {
      return await result;
    } finally {
      void client.invalidateQueries({ queryKey: contextKey(context) });
    }
  };
  return {
    refresh: () => client.invalidateQueries({ queryKey: inventoryKey(context) }),
    writeDocument: (input: Omit<SkillInput<"writeDocument">, keyof SkillInventoryContext>) =>
      invalidate(skillInventoryAdapter.writeDocument({ ...context, ...input })),
    createBlank: (input: Omit<SkillInput<"createBlank">, keyof SkillInventoryContext>) =>
      invalidate(skillInventoryAdapter.createBlank({ ...context, ...input })),
    rename: (input: Omit<SkillInput<"rename">, keyof SkillInventoryContext>) =>
      invalidate(skillInventoryAdapter.rename({ ...context, ...input })),
    transfer: (input: Omit<SkillInput<"transfer">, keyof SkillInventoryContext>) =>
      invalidate(skillInventoryAdapter.transfer({ ...context, ...input })),
    trash: (input: Omit<SkillInput<"trash">, keyof SkillInventoryContext>) =>
      invalidate(skillInventoryAdapter.trash({ ...context, ...input })),
    setEnabled: (input: Omit<SkillInput<"setEnabled">, keyof SkillInventoryContext>) =>
      invalidate(skillInventoryAdapter.setEnabled({ ...context, ...input })),
  };
}

export function useSkillCommands({ hostId, projectId }: SkillInventoryContext) {
  const client = useQueryClient();
  return useMemo(() => skillCommands(client, { hostId, projectId }), [client, hostId, projectId]);
}
