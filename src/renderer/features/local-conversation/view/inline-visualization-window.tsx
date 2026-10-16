import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  createInlineVisualizationFrameOwner,
  type InlineVisualizationFrameOwner,
} from "../../../lib/inline-visualization/inline-visualization-frame-owner";
import { InlineVisualizationFrameView } from "./inline-visualization-frame";
import { startInlineVisualizationPrewarmer } from "../../../lib/inline-visualization/inline-visualization-prewarmer";
import { registerAppCloseFlushHandler } from "../../../lib/app-close-flush";

const FrameOwnerContext = createContext<InlineVisualizationFrameOwner | null>(null);
export const InlineVisualizationSurfaceContext = createContext<string | null>(null);
export const useInlineVisualizationFrameOwner = () => useContext(FrameOwnerContext);

/** Each renderer window retains its own guests; a Thread leaf only binds a visible anchor. */
export function InlineVisualizationWindowProvider({ children }: { readonly children: ReactNode }) {
  const [owner] = useState(createInlineVisualizationFrameOwner);
  const [standbyRoot, setStandbyRoot] = useState<HTMLDivElement | null>(null);
  const ids = useSyncExternalStore(owner.subscribe, owner.readIds, owner.readIds);
  useLayoutEffect(() => {
    const releaseWindow = owner.acquireWindow();
    const stopPrewarmer = standbyRoot
      ? startInlineVisualizationPrewarmer(standbyRoot, { start: owner.startStandby })
      : undefined;
    const unregisterClose = registerAppCloseFlushHandler(() => {
      stopPrewarmer?.();
      // Detach native guests while the window's synchronous IPC is still available.
      owner.dispose();
    });
    return () => {
      unregisterClose();
      stopPrewarmer?.();
      releaseWindow();
    };
  }, [owner, standbyRoot]);
  return (
    <FrameOwnerContext.Provider value={owner}>
      <div
        ref={(parking) => owner.setParking(parking)}
        hidden
        inert
        aria-hidden="true"
        data-inline-visualization-parking="true"
      />
      <div
        ref={setStandbyRoot}
        inert
        aria-hidden="true"
        data-inline-visualization-standby-root="true"
        className="pointer-events-none fixed -left-1 -top-1 h-px w-px overflow-hidden opacity-0"
      />
      {children}
      {ids.map((id) => (
        <FramePortal key={id} owner={owner} id={id} />
      ))}
    </FrameOwnerContext.Provider>
  );
}

function FramePortal({
  owner,
  id,
}: {
  readonly owner: InlineVisualizationFrameOwner;
  readonly id: string;
}) {
  const frame = owner.readFrame(id);
  if (!frame) return null;
  return createPortal(<InlineVisualizationFrameView owner={owner} id={id} />, frame.container);
}

export function InlineVisualizationSurfaceProvider({
  id,
  hostId,
  threadId,
  active,
  children,
}: {
  readonly id: string;
  readonly hostId: string;
  readonly threadId: string | null;
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const owner = useInlineVisualizationFrameOwner();
  useLayoutEffect(() => {
    owner?.setSurface(id, active ? hostId : null, active ? threadId : null);
    return () => owner?.setSurface(id, null, null);
  }, [owner, id, hostId, threadId, active]);
  return (
    <InlineVisualizationSurfaceContext.Provider value={id}>
      {children}
    </InlineVisualizationSurfaceContext.Provider>
  );
}
