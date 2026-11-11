import { useEffect, useEffectEvent, useRef, useState } from "react";

/** Run an opt-in interaction once, using the eligibility of the initial render. */
export function useMountAction(enabled: boolean, action: () => void) {
  const [requested] = useState(enabled);
  const handled = useRef(false);
  const run = useEffectEvent(action);

  useEffect(() => {
    if (!requested || handled.current) return;
    handled.current = true;
    run();
  }, [requested]);
}
