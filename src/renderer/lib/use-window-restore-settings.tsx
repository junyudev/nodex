import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { queryKeys } from "./query-keys";
import type { UpdateWindowRestoreSettingsInput, WindowRestoreSettings } from "./types";
import {
  DEFAULT_WINDOW_RESTORE_SETTINGS,
  normalizeWindowRestoreSettings,
  resetMainReturnedSettingsOwnersForTests,
  windowRestoreSettingsOwnerFor,
} from "./main-returned-settings";

export function useWindowRestoreSettings(): {
  settings: WindowRestoreSettings;
  isLoading: boolean;
  updateSettings: (input: UpdateWindowRestoreSettingsInput) => Promise<WindowRestoreSettings>;
  reloadSettings: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const owner = useMemo(() => windowRestoreSettingsOwnerFor(queryClient), [queryClient]);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const { isPending } = useQuery({
    queryKey: queryKeys.settings.windowRestore(),
    queryFn: owner.readCanonical,
  });

  useLayoutEffect(() => {
    if (snapshot.renderToken === null) return;
    owner.markRendered(snapshot.renderToken);
  }, [owner, snapshot.renderToken]);

  const reloadSettings = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.settings.windowRestore(),
      exact: true,
    });
  }, [queryClient]);

  const updateSettings = useCallback(
    async (input: UpdateWindowRestoreSettingsInput) => {
      return await owner.update(normalizeWindowRestoreSettings(input));
    },
    [owner],
  );

  return {
    settings: snapshot.value ?? DEFAULT_WINDOW_RESTORE_SETTINGS,
    isLoading: isPending,
    updateSettings,
    reloadSettings,
  };
}

export const __resetWindowRestoreSettingsForTests = resetMainReturnedSettingsOwnersForTests;
