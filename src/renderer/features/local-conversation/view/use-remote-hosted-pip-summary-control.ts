import { remoteHostedPipRuntime } from "@/lib/remote-hosted-pip-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RemoteHostedPipTaskStateSnapshot } from "../../../../shared/remote-hosted-pip";
import type {
  ThreadStageActions,
  ThreadSummaryPanelComputerUsePipState,
} from "../thread-stage-types";

interface RemoteHostedPipSummaryControl {
  onToggleSummaryComputerUsePip: NonNullable<ThreadStageActions["onToggleSummaryComputerUsePip"]>;
  summaryComputerUsePip: ThreadSummaryPanelComputerUsePipState | null;
}

function selectNewerSnapshot(
  current: RemoteHostedPipTaskStateSnapshot | null,
  candidate: RemoteHostedPipTaskStateSnapshot,
): RemoteHostedPipTaskStateSnapshot {
  if (!current || candidate.revision > current.revision) return candidate;
  if (
    candidate.revision === current.revision &&
    JSON.stringify(candidate) !== JSON.stringify(current)
  ) {
    console.warn("[remote-hosted-pip] conflicting snapshots share one revision", {
      revision: candidate.revision,
    });
  }
  return current;
}

export function useRemoteHostedPipSummaryControl(
  activeThreadId: string | null,
): RemoteHostedPipSummaryControl {
  const [snapshot, setSnapshot] = useState<RemoteHostedPipTaskStateSnapshot | null>(null);

  useEffect(() => {
    let accepting = true;
    const refresh = async (): Promise<void> => {
      const next = await remoteHostedPipRuntime.snapshot().catch(() => null);
      if (!accepting || !next) return;
      setSnapshot((current) => selectNewerSnapshot(current, next));
    };
    void refresh();
    const unsubscribe = window.api?.on("remote-hosted-pip:revision", (value) => {
      const event = value as { readonly revision?: unknown };
      if (!Number.isSafeInteger(event.revision)) return;
      setSnapshot((current) => {
        if (current && (event.revision as number) <= current.revision) return current;
        void refresh();
        return current;
      });
    });
    return () => {
      accepting = false;
      unsubscribe?.();
    };
  }, []);

  const summaryComputerUsePip = useMemo<ThreadSummaryPanelComputerUsePipState | null>(() => {
    if (
      !activeThreadId ||
      !snapshot?.taskVisibilityActionAvailable ||
      !snapshot.activeTaskIds.includes(activeThreadId)
    ) {
      return null;
    }
    return {
      visible: !snapshot.alwaysHidden && snapshot.taskVisibilities[activeThreadId] !== "hidden",
    };
  }, [activeThreadId, snapshot]);

  const onToggleSummaryComputerUsePip = useCallback(
    (nextVisible: boolean) => {
      if (!activeThreadId || !window.api) return;
      void remoteHostedPipRuntime
        .setTaskVisibility({
          taskId: activeThreadId,
          visibility: nextVisible ? "shown" : "hidden",
        })
        .then((next) => setSnapshot((current) => selectNewerSnapshot(current, next)))
        .catch(() => undefined);
    },
    [activeThreadId],
  );

  return { onToggleSummaryComputerUsePip, summaryComputerUsePip };
}
