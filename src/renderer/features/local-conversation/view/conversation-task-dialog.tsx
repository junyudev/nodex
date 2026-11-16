import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
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
import {
  useConversationRuntimeChildMemberships,
  useConversationRuntimeValue,
} from "../conversation-runtime-hooks";

const selectConversation = (conversation: CodexConversationSnapshot | null) => conversation;

export interface ConversationTaskDialogProps {
  readonly runtime: ConversationRuntime;
  readonly parentThreadId: string;
  /** The opening Route retains its Thread ancestry when details outlive the trigger. */
  readonly parentContext: ScopeHandle;
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
  parentContext,
  initialTaskId,
  renderDetail,
  stopTask,
  onClose,
}: ConversationTaskDialogProps) {
  const intl = useIntl();
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId ?? null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tasks = useConversationRuntimeChildMemberships(runtime, parentThreadId);
  const selected = tasks.find((task) => task.threadId === selectedId) ?? tasks[0];
  const conversation = useConversationRuntimeValue(
    runtime,
    selected?.threadId ?? null,
    selectConversation,
  );
  return (
    <ScopeContextBridge handle={parentContext}>
      <NodexDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <NodexDialogContent size="large">
          <NodexDialogFrame className="max-h-[85vh] min-h-0">
            <NodexDialogHeader>
              <NodexDialogTitle>
                <FormattedMessage id="conversation.taskDialog.title" defaultMessage="Tasks" />
              </NodexDialogTitle>
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
                    <span className="text-sm text-token-description-foreground">
                      <FormattedMessage
                        id="conversation.taskDialog.empty"
                        defaultMessage="No tasks"
                      />
                    </span>
                  ) : null}
                  {tasks.map((membership) => {
                    const task = membership.task;
                    const live = membership.statusType === "active";
                    const status = live
                      ? task?.ambient
                        ? intl.formatMessage({
                            id: "conversation.taskDialog.watching",
                            defaultMessage: "Watching",
                          })
                        : task?.status === "paused"
                          ? intl.formatMessage({
                              id: "conversation.taskDialog.paused",
                              defaultMessage: "Paused",
                            })
                          : intl.formatMessage({
                              id: "conversation.taskDialog.running",
                              defaultMessage: "Running",
                            })
                      : task?.status === "failed"
                        ? intl.formatMessage({
                            id: "conversation.taskDialog.failed",
                            defaultMessage: "Failed",
                          })
                        : task?.status === "cancelled"
                          ? intl.formatMessage({
                              id: "conversation.taskDialog.stopped",
                              defaultMessage: "Stopped",
                            })
                          : task?.status === "completed"
                            ? intl.formatMessage({
                                id: "conversation.taskDialog.completed",
                                defaultMessage: "Completed",
                              })
                            : intl.formatMessage({
                                id: "conversation.taskDialog.inactive",
                                defaultMessage: "Inactive",
                              });
                    return (
                      <div key={membership.threadId} className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-pressed={selected?.threadId === membership.threadId}
                          aria-label={intl.formatMessage(
                            {
                              id: "conversation.taskDialog.taskStatus",
                              defaultMessage: "{name}, {status}",
                            },
                            {
                              name:
                                membership.displayName ??
                                intl.formatMessage({
                                  id: "conversation.taskDialog.unnamedTask",
                                  defaultMessage: "Task",
                                }),
                              status,
                            },
                          )}
                          className="flex min-w-0 flex-1 cursor-interaction flex-col rounded-md px-2 py-2 text-left hover:bg-token-list-hover-background aria-pressed:bg-token-list-hover-background"
                          onClick={() => setSelectedId(membership.threadId)}
                        >
                          <span className="w-full truncate text-sm">
                            {membership.displayName ??
                              intl.formatMessage({
                                id: "conversation.taskDialog.unnamedTask",
                                defaultMessage: "Task",
                              })}
                          </span>
                          <span className="text-xs text-token-description-foreground">
                            {status}
                          </span>
                        </button>
                        {live && task && stopTask ? (
                          <button
                            type="button"
                            aria-label={intl.formatMessage(
                              {
                                id: "conversation.taskDialog.stopNamedTask",
                                defaultMessage: "Stop {name}",
                              },
                              {
                                name:
                                  membership.displayName ??
                                  intl.formatMessage({
                                    id: "conversation.taskDialog.genericTask",
                                    defaultMessage: "task",
                                  }),
                              },
                            )}
                            className="cursor-interaction px-1 text-xs text-token-description-foreground hover:text-token-foreground disabled:opacity-50"
                            disabled={stopping === task.id}
                            onClick={() => {
                              setStopping(task.id);
                              setError(null);
                              void stopTask(task.id)
                                .catch((cause: unknown) =>
                                  setError(
                                    cause instanceof Error
                                      ? cause.message
                                      : getIntl().formatMessage({
                                          id: "conversation.taskDialog.stopFailed",
                                          defaultMessage: "Could not stop task",
                                        }),
                                  ),
                                )
                                .finally(() => setStopping(null));
                            }}
                          >
                            {stopping === task.id
                              ? intl.formatMessage({
                                  id: "conversation.taskDialog.stopping",
                                  defaultMessage: "Stopping",
                                })
                              : intl.formatMessage({
                                  id: "conversation.taskDialog.stop",
                                  defaultMessage: "Stop",
                                })}
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
