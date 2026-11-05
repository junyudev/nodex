import { useEffect, useState } from "react";

const MINUTE = 60_000;

/** The time to show relative labels against, refreshed once a minute so they do not go stale. */
export const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, []);
  return now;
};
