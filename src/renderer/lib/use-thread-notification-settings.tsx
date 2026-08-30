import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { queryKeys } from "./query-keys";
import type { ThreadNotificationSettings, UpdateThreadNotificationSettingsInput } from "./types";
import {
  DEFAULT_THREAD_NOTIFICATION_SETTINGS,
  normalizeThreadNotificationSettings,
  resetMainReturnedSettingsOwnersForTests,
  threadNotificationSettingsOwnerFor,
} from "./main-returned-settings";

export function useThreadNotificationSettings(): {
  settings: ThreadNotificationSettings;
  isLoading: boolean;
  updateSettings: (
    input: UpdateThreadNotificationSettingsInput,
  ) => Promise<ThreadNotificationSettings>;
  reloadSettings: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const owner = useMemo(() => threadNotificationSettingsOwnerFor(queryClient), [queryClient]);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const { isPending } = useQuery({
    queryKey: queryKeys.settings.threadNotifications(),
    queryFn: owner.readCanonical,
  });

  useLayoutEffect(() => {
    if (snapshot.renderToken === null) return;
    owner.markRendered(snapshot.renderToken);
  }, [owner, snapshot.renderToken]);

  const reloadSettings = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.settings.threadNotifications(),
      exact: true,
    });
  }, [queryClient]);

  const updateSettings = useCallback(
    async (input: UpdateThreadNotificationSettingsInput) => {
      return await owner.update(normalizeThreadNotificationSettings(input));
    },
    [owner],
  );

  return {
    settings: snapshot.value ?? DEFAULT_THREAD_NOTIFICATION_SETTINGS,
    isLoading: isPending,
    updateSettings,
    reloadSettings,
  };
}

export const __resetThreadNotificationSettingsForTests = resetMainReturnedSettingsOwnersForTests;
