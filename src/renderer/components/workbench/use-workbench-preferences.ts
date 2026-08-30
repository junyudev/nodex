import { useCallback, useEffect } from "react";
import { isCodexGitSettings } from "../../../shared/codex-git-settings";
import { readCodexGitSettings } from "../../lib/codex-git-settings";
import {
  readComposerEnterBehavior,
  writeComposerEnterBehavior,
  type ComposerEnterBehavior,
} from "../../lib/composer-enter-behavior";
import { appScope, scopedAtomWithInitializer, useScopedAtom } from "../../lib/maitai";
import {
  readTaskShorthandPagePromotionEnabled,
  writeTaskShorthandPagePromotionEnabled,
} from "../../lib/page-promotion-preference";
import {
  readThreadQueueFollowUpsEnabled,
  writeThreadQueueFollowUpsEnabled,
} from "../../lib/thread-composer-follow-up-mode";
import type { WorktreeStartMode } from "../../lib/types";
import {
  readWorktreeAutoBranchPrefix,
  writeWorktreeAutoBranchPrefix,
} from "../../lib/worktree-branch-prefix";
import { readWorktreeStartMode, writeWorktreeStartMode } from "../../lib/worktree-start-mode";

const THREAD_SUMMARY_PANEL_STORAGE_KEY = "nodex:thread-summary-panel:pinned-open";

function readThreadSummaryPanelPinnedOpen(): boolean {
  try {
    const raw = localStorage.getItem(THREAD_SUMMARY_PANEL_STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function writeThreadSummaryPanelPinnedOpen(open: boolean): boolean {
  try {
    localStorage.setItem(THREAD_SUMMARY_PANEL_STORAGE_KEY, String(open));
  } catch {
    // Keep the renderer value when browser storage is unavailable.
  }
  return open;
}

const threadSummaryPanelPinnedOpenAtom = scopedAtomWithInitializer(
  appScope,
  readThreadSummaryPanelPinnedOpen,
  { debugLabel: "thread-summary-panel-pinned-open" },
);
const threadQueueFollowUpsEnabledAtom = scopedAtomWithInitializer(
  appScope,
  readThreadQueueFollowUpsEnabled,
  { debugLabel: "thread-queue-follow-ups-enabled" },
);
const composerEnterBehaviorAtom = scopedAtomWithInitializer(appScope, readComposerEnterBehavior, {
  debugLabel: "composer-enter-behavior",
});
const worktreeStartModeAtom = scopedAtomWithInitializer(appScope, readWorktreeStartMode, {
  debugLabel: "worktree-start-mode",
});
const worktreeAutoBranchPrefixAtom = scopedAtomWithInitializer(
  appScope,
  readWorktreeAutoBranchPrefix,
  { debugLabel: "worktree-auto-branch-prefix" },
);
const taskShorthandPagePromotionEnabledAtom = scopedAtomWithInitializer(
  appScope,
  readTaskShorthandPagePromotionEnabled,
  { debugLabel: "task-shorthand-page-promotion-enabled" },
);

export function useWorkbenchPreferences() {
  const [threadSummaryPanelPinnedOpen, setThreadSummaryPanelPinnedOpen] = useScopedAtom(
    threadSummaryPanelPinnedOpenAtom,
  );
  const [threadQueueFollowUpsEnabled, setThreadQueueFollowUpsEnabled] = useScopedAtom(
    threadQueueFollowUpsEnabledAtom,
  );
  const [composerEnterBehavior, setComposerEnterBehavior] =
    useScopedAtom(composerEnterBehaviorAtom);
  const [worktreeStartMode, setWorktreeStartMode] = useScopedAtom(worktreeStartModeAtom);
  const [worktreeAutoBranchPrefix, setWorktreeAutoBranchPrefix] = useScopedAtom(
    worktreeAutoBranchPrefixAtom,
  );
  const [taskShorthandPagePromotionEnabled, setTaskShorthandPagePromotionEnabled] = useScopedAtom(
    taskShorthandPagePromotionEnabledAtom,
  );

  useEffect(() => {
    let disposed = false;
    void readCodexGitSettings()
      .then((settings) => {
        if (disposed || !isCodexGitSettings(settings)) return;
        setWorktreeAutoBranchPrefix(writeWorktreeAutoBranchPrefix(settings.branchPrefix));
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [setWorktreeAutoBranchPrefix]);

  const toggleThreadSummaryPanelPinnedOpen = useCallback(() => {
    setThreadSummaryPanelPinnedOpen((current) => writeThreadSummaryPanelPinnedOpen(!current));
  }, [setThreadSummaryPanelPinnedOpen]);

  const handleThreadQueueFollowUpsEnabledChange = useCallback(
    (value: boolean) => {
      setThreadQueueFollowUpsEnabled(writeThreadQueueFollowUpsEnabled(value));
    },
    [setThreadQueueFollowUpsEnabled],
  );

  const handleComposerEnterBehaviorChange = useCallback(
    (value: ComposerEnterBehavior) => {
      setComposerEnterBehavior(writeComposerEnterBehavior(value));
    },
    [setComposerEnterBehavior],
  );

  const handleWorktreeStartModeChange = useCallback(
    (value: WorktreeStartMode) => {
      setWorktreeStartMode(writeWorktreeStartMode(value));
    },
    [setWorktreeStartMode],
  );

  const handleWorktreeAutoBranchPrefixChange = useCallback(
    (value: string) => {
      setWorktreeAutoBranchPrefix(writeWorktreeAutoBranchPrefix(value));
    },
    [setWorktreeAutoBranchPrefix],
  );

  const handleTaskShorthandPagePromotionEnabledChange = useCallback(
    (value: boolean) => {
      setTaskShorthandPagePromotionEnabled(writeTaskShorthandPagePromotionEnabled(value));
    },
    [setTaskShorthandPagePromotionEnabled],
  );

  return {
    threadSummaryPanelPinnedOpen,
    toggleThreadSummaryPanelPinnedOpen,
    threadQueueFollowUpsEnabled,
    handleThreadQueueFollowUpsEnabledChange,
    composerEnterBehavior,
    handleComposerEnterBehaviorChange,
    worktreeStartMode,
    handleWorktreeStartModeChange,
    worktreeAutoBranchPrefix,
    handleWorktreeAutoBranchPrefixChange,
    taskShorthandPagePromotionEnabled,
    handleTaskShorthandPagePromotionEnabledChange,
  };
}

export const workbenchPreferenceTestHelpers = {
  readThreadSummaryPanelPinnedOpen,
  writeThreadSummaryPanelPinnedOpen,
};
