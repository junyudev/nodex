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

const FrameOwnerContext = createContext<InlineVisualizationFrameOwner | null>(null);
export const InlineVisualizationSurfaceContext = createContext<string | null>(null);
export const useInlineVisualizationFrameOwner = () => useContext(FrameOwnerContext);

/** Each renderer window retains its own guests; a Thread leaf only binds a visible anchor. */
export function InlineVisualizationWindowProvider({ children }: { readonly children: ReactNode }) {
  const [owner] = useState(createInlineVisualizationFrameOwner);
  const ids = useSyncExternalStore(owner.subscribe, owner.readIds, owner.readIds);
  useLayoutEffect(() => owner.acquireWindow(), [owner]);
  return (
    <FrameOwnerContext.Provider value={owner}>
      <div
        ref={owner.setParking}
        hidden
        inert
        aria-hidden="true"
        data-inline-visualization-parking="true"
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
