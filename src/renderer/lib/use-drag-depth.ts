import { useRef, useState } from "react";

/**
 * Whether a drag a drop target takes is over it. A drag enters and leaves each element it passes
 * over inside the target, so it has left only when every enter has been matched.
 */
export function useDragDepth() {
  const depth = useRef(0);
  const [active, setActive] = useState(false);
  return {
    active,
    enter: () => {
      depth.current += 1;
      setActive(true);
    },
    /** False when no drag the target took is over it, so the event is not its to handle. */
    leave: () => {
      if (depth.current === 0) return false;
      depth.current -= 1;
      if (depth.current === 0) setActive(false);
      return true;
    },
    end: () => {
      depth.current = 0;
      setActive(false);
    },
  };
}
