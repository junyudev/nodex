import { useEffect, useEffectEvent } from "react";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

type ElementMonitorArgs = Parameters<typeof monitorForElements>[0];
type CanMonitor = NonNullable<ElementMonitorArgs["canMonitor"]>;
type OnDragStart = NonNullable<ElementMonitorArgs["onDragStart"]>;
type OnDrag = NonNullable<ElementMonitorArgs["onDrag"]>;
type OnDrop = NonNullable<ElementMonitorArgs["onDrop"]>;

interface UseBoardElementDragMonitorOptions {
  readonly scopeKey: symbol;
  readonly canMonitor: CanMonitor;
  readonly onDragStart: OnDragStart;
  readonly onDrag: OnDrag;
  readonly onDrop: OnDrop;
}

/**
 * Keeps one Pragmatic monitor subscribed for the lifetime of a Board.
 * Effect Events provide current render state without tearing down the monitor
 * during an active drag.
 */
export function useBoardElementDragMonitor({
  scopeKey,
  canMonitor,
  onDragStart,
  onDrag,
  onDrop,
}: UseBoardElementDragMonitorOptions): void {
  const readCanMonitor = useEffectEvent(
    (registeredScope: symbol, args: Parameters<CanMonitor>[0]) =>
      registeredScope === scopeKey && canMonitor(args),
  );
  const handleDragStart = useEffectEvent(onDragStart);
  const handleDrag = useEffectEvent(onDrag);
  const handleDrop = useEffectEvent(onDrop);

  useEffect(() => {
    const cleanup = monitorForElements({
      canMonitor: (args) => readCanMonitor(scopeKey, args),
      onDragStart: (args) => handleDragStart(args),
      onDrag: (args) => handleDrag(args),
      onDrop: (args) => handleDrop(args),
    });
    return cleanup;
  }, [scopeKey]);
}
