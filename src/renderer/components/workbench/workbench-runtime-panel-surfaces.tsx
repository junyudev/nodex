import { useState, useSyncExternalStore } from "react";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useConversation } from "@/features/local-conversation";
import { McpCapabilityViewFrame } from "@/features/local-conversation/view/shared/tools/mcp-capability-view-frame";
import { terminalSessionStore } from "@/lib/terminal-session-store";
import type { TerminalSessionSnapshot } from "../../../shared/types";
import { findProcessOutputCommandItem } from "@/lib/workbench-process-output-target";
import type { McpAppPanelTab, ProcessOutputPanelTab } from "@/lib/workbench-panel-tab-model";

export function McpAppSessionTab({ tab }: { tab: McpAppPanelTab }) {
  return (
    <div
      className="h-full min-h-0 bg-token-main-surface-primary"
      data-mcp-app-side-panel-tab={tab.id}
      data-mcp-capability-id={tab.app.capabilityId}
    >
      <McpCapabilityViewFrame capabilityId={tab.app.capabilityId} mode="side-panel" />
    </div>
  );
}

/** Retains the final output after the terminal owner releases its exited record. */
function createProcessOutputSnapshotSource(sessionId: string | null) {
  let snapshot: TerminalSessionSnapshot | null | undefined;
  return {
    sessionId,
    getSnapshot: (): TerminalSessionSnapshot | null => {
      if (snapshot === undefined)
        snapshot = sessionId ? terminalSessionStore.getSnapshot(sessionId) : null;
      return snapshot;
    },
    subscribe(onChange: () => void) {
      if (!sessionId) return () => {};
      let cancelled = false;
      terminalSessionStore.ensureEventSubscriptions();
      if (!snapshot?.exited) snapshot = terminalSessionStore.getSnapshot(sessionId);
      const unsubscribe = terminalSessionStore.subscribe(sessionId, (event) => {
        if (event.type === "exit" && snapshot) {
          snapshot = { ...snapshot, exited: true, exitCode: event.exitCode };
        } else {
          snapshot = terminalSessionStore.getSnapshot(sessionId);
        }
        onChange();
      });
      void terminalSessionStore.fetchSnapshot(sessionId).then((nextSnapshot) => {
        if (cancelled || !nextSnapshot) return;
        snapshot = nextSnapshot;
        onChange();
      });
      return () => {
        cancelled = true;
        unsubscribe();
      };
    },
  };
}

function useProcessOutputTerminalSnapshot(
  sessionId: string | null,
): TerminalSessionSnapshot | null {
  const [source, setSource] = useState(() => createProcessOutputSnapshotSource(sessionId));
  if (source.sessionId !== sessionId) setSource(createProcessOutputSnapshotSource(sessionId));
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

export function ProcessOutputPanelTabView({ tab }: { tab: ProcessOutputPanelTab }) {
  const conversation = useConversation(tab.threadId);
  const terminalSnapshot = useProcessOutputTerminalSnapshot(tab.terminalSessionId);
  const item = findProcessOutputCommandItem(conversation, tab.itemId, tab.turnId);
  const command = item?.command ?? tab.command;
  const cwd = terminalSnapshot?.cwd ?? item?.cwd ?? tab.cwd;
  const output = terminalSnapshot ? terminalSnapshot.buffer : (item?.aggregatedOutput ?? "");
  const displayCommand = command.trim() || "Background terminal";
  const displayOutput = output.trimEnd();

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
      data-process-output-panel-tab={tab.id}
      data-thread-id={tab.threadId}
      data-item-id={tab.itemId}
    >
      <div className="flex min-h-14 shrink-0 flex-col justify-center border-b border-token-border px-3 py-2">
        <NodexTooltip tooltipContent={displayCommand} side="top">
          <div className="truncate font-mono text-xs text-token-foreground">{displayCommand}</div>
        </NodexTooltip>
        {cwd ? (
          <NodexTooltip tooltipContent={cwd} side="top">
            <div className="mt-1 truncate text-xs text-token-description-foreground">{cwd}</div>
          </NodexTooltip>
        ) : null}
      </div>
      {displayOutput ? (
        <LazySourceViewer
          value={displayOutput}
          ariaLabel={`Process output for ${displayCommand}`}
          sourceIdentity={tab.terminalSessionId ?? `${tab.threadId}:${tab.itemId}`}
          className="min-h-0 flex-1"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-token-description-foreground">
          No output yet
        </div>
      )}
    </div>
  );
}
