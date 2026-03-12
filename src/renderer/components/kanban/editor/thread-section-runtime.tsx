import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export interface ThreadSectionLinkedThreadState {
  threadId: string;
  threadName: string;
  threadPreview: string;
  statusType: "notLoaded" | "idle" | "active" | "systemError";
  statusActiveFlags: string[];
  archived: boolean;
  updatedAt: number;
}

export interface ThreadSectionRuntimeValue {
  threads: Record<string, ThreadSectionLinkedThreadState>;
  pendingBlockIds: Set<string>;
  openThread?: (threadId: string) => void;
  send?: (blockId: string) => void;
}

const EMPTY_PENDING_BLOCK_IDS = new Set<string>();

const ThreadSectionRuntimeContext = createContext<ThreadSectionRuntimeValue>({
  threads: {},
  pendingBlockIds: EMPTY_PENDING_BLOCK_IDS,
});

export function ThreadSectionRuntimeProvider({
  value,
  children,
}: {
  value: ThreadSectionRuntimeValue;
  children: ReactNode;
}) {
  return (
    <ThreadSectionRuntimeContext.Provider value={value}>
      {children}
    </ThreadSectionRuntimeContext.Provider>
  );
}

export function useThreadSectionRuntime(): ThreadSectionRuntimeValue {
  return useContext(ThreadSectionRuntimeContext);
}
