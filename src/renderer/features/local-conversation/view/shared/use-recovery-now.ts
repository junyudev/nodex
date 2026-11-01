import { useEffect, useState } from "react";
import type { ConversationRecovery } from "../../../../../shared/conversation-recovery";

/** The present for a recovery countdown: ticks each second until its next attempt is due. */
export function useRecoveryNow(recovery: ConversationRecovery | undefined): number {
  const [now, setNow] = useState(Date.now);
  const state = recovery?.state;
  const retryAt = recovery?.retryAt;
  useEffect(() => {
    if (state !== "retrying" || retryAt == null || !Number.isFinite(retryAt)) return;
    const update = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= retryAt) window.clearInterval(interval);
    };
    const interval = window.setInterval(update, 1000);
    update();
    return () => window.clearInterval(interval);
  }, [retryAt, state]);
  return now;
}
