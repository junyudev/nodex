import { useEffect, useState } from "react";

/** Keeps relative times and day groups current while the Inbox stays open. */
export function useInboxClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
