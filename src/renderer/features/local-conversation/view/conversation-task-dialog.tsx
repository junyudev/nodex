import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  NodexDialog,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import type { CodexConversationSnapshot } from "../../../../shared/types";
import type { ConversationRuntime } from "../conversation-runtime";
import { ScopeContextBridge, type ScopeHandle } from "@/lib/maitai";

export interface ConversationTaskDialogProps {
  readonly runtime: ConversationRuntime;
  readonly parentThreadId: string;
  readonly parentThreadScope: ScopeHandle;
  readonly initialTaskId?: string;
  readonly renderDetail: (conversation: CodexConversationSnapshot) => ReactNode;
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly onClose: () => void;
}

/** Task details observe the native session; selection cannot attach or execute a Thread. */
export function ConversationTaskDialog(props: ConversationTaskDialogProps) {
  return (
    <ConversationTaskDialogContent
      key={`${props.parentThreadId}:${props.initialTaskId ?? "all"}`}
      {...props}
    />
  );
}

function ConversationTaskDialogContent({
  runtime,
  parentThreadId,
  parentThreadScope,
  initialTaskId,
  renderDetail,
  stopTask,
  onClose,
}: ConversationTaskDialogProps) {
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribe(parentThreadId, listener),
    [runtime, parentThreadId],
  );
  const readParent = useCallback(() => runtime.read(parentThreadId), [runtime, parentThreadId]);
  useSyncExternalStore(subscribe, readParent, readParent);
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId ?? null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tasks = runtime.children(parentThreadId);
  const selected = tasks.find((task) => task.threadId === selectedId) ?? tasks[0];
  const conversation = selected ? runtime.read(selected.threadId) : null;
  return (
    <ScopeContextBridge handle={parentThreadScope}>
      <NodexDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <NodexDialogContent size="large">
          <NodexDialogFrame className="max-h-[85vh] min-h-0">
            <NodexDialogHeader>
              <NodexDialogTitle>Tasks</NodexDialogTitle>
            </NodexDialogHeader>
            <NodexDialogBody className="min-h-0">
              {error ? (
                <p role="alert" className="pb-2 text-sm text-token-charts-red">
                  {error}
                </p>
              ) : null}
              <div className="flex min-h-0 flex-1 gap-4">
                <div className="max-h-[65vh] w-44 shrink-0 overflow-y-auto">
                  {tasks.length === 0 ? (
                    <span className="text-sm text-token-description-foreground">No tasks</span>
                  ) : null}
                  {tasks.map((membership) => {
                    const task = membership.task;
                    const live = membership.statusType === "active";
                    const status = live
                      ? task?.ambient
                        ? "Watching"
                        : task?.status === "paused"
                          ? "Paused"
                          : "Running"
                      : task?.status === "failed"
                        ? "Failed"
                        : task?.status === "cancelled"
                          ? "Stopped"
                          : task?.status === "completed"
                            ? "Completed"
                            : "Inactive";
                    return (
                      <div key={membership.threadId} className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-pressed={selected?.threadId === membership.threadId}
                          aria-label={`${membership.displayName ?? "Task"}, ${status}`}
                          className="flex min-w-0 flex-1 cursor-interaction flex-col rounded-md px-2 py-2 text-left hover:bg-token-list-hover-background aria-pressed:bg-token-list-hover-background"
                          onClick={() => setSelectedId(membership.threadId)}
                        >
                          <span className="w-full truncate text-sm">
                            {membership.displayName ?? "Task"}
                          </span>
                          <span className="text-xs text-token-description-foreground">
                            {status}
                          </span>
                        </button>
                        {live && task && stopTask ? (
                          <button
                            type="button"
                            aria-label={`Stop ${membership.displayName ?? "task"}`}
                            className="cursor-interaction px-1 text-xs text-token-description-foreground hover:text-token-foreground disabled:opacity-50"
                            disabled={stopping === task.id}
                            onClick={() => {
                              setStopping(task.id);
                              setError(null);
                              void stopTask(task.id)
                                .catch((cause: unknown) =>
                                  setError(
                                    cause instanceof Error ? cause.message : "Could not stop task",
                                  ),
                                )
                                .finally(() => setStopping(null));
                            }}
                          >
                            {stopping === task.id ? "Stopping" : "Stop"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="min-h-[240px] min-w-0 flex-1 overflow-hidden">
                  {conversation ? renderDetail(conversation) : null}
                </div>
              </div>
            </NodexDialogBody>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </ScopeContextBridge>
  );
}
