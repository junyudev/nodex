import { useState, type KeyboardEvent } from "react";
import { UpArrowIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { acpBackendRuntime, type AcpBackendRuntime } from "@/lib/acp-backend-runtime";
import { sessionFirstSubmissionOwner } from "@/features/conversation-launch/session-first-submission-owner";
import { useSessionFirstSubmission } from "@/features/conversation-launch/use-session-first-submission";

export interface AcpNewConversationStageProps {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly instanceConfigId: string;
  readonly agentLabel: string;
  readonly projectName: string | null;
  readonly onStarted: (threadId: string) => void | Promise<void>;
  readonly runtime?: Pick<AcpBackendRuntime, "startThread">;
}

export function AcpNewConversationStage({
  sessionId,
  projectId,
  instanceConfigId,
  agentLabel,
  projectName,
  onStarted,
  runtime = acpBackendRuntime,
}: AcpNewConversationStageProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstSubmission = useSessionFirstSubmission({
    projectId,
    sessionId,
    threadId: null,
  });

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || pending || !projectName) return;
    const submission = sessionFirstSubmissionOwner.begin({
      backend: "acp",
      originProjectId: projectId,
      originSessionId: sessionId,
      prompt,
    });
    setDraft("");
    setPending(true);
    setError(null);
    try {
      const result = await runtime.startThread({
        sessionId,
        instanceConfigId,
        prompt,
        firstSubmission: {
          launchId: submission.launchId,
          clientUserMessageId: submission.clientUserMessageId,
        },
      });
      sessionFirstSubmissionOwner.update(submission.launchId, {
        threadId: result.thread.threadId,
        phase: "startingTurn",
      });
      await onStarted(result.thread.threadId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `Could not start ${agentLabel}`;
      sessionFirstSubmissionOwner.fail(submission.launchId, {
        stage: "startingThread",
        message,
      });
      setDraft(prompt);
      setError(message);
      setPending(false);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.shiftKey || event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary text-foreground">
      <header className="border-default flex min-h-10 shrink-0 items-center gap-2 border-b-[0.5px] px-3">
        <span className="text-sm font-medium text-foreground">{agentLabel}</span>
        <span className="text-xs text-tertiary">New task</span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-16 text-center">
        {firstSubmission ? (
          <div
            className="ml-auto max-w-[85%] rounded-lg bg-text/10 px-3 py-2 text-left text-sm whitespace-pre-wrap text-foreground"
            data-client-user-message-id={firstSubmission.clientUserMessageId}
            data-user-message-bubble="true"
          >
            {firstSubmission.prompt}
          </div>
        ) : (
          <div className="max-w-md">
            <div className="text-base font-medium text-foreground">Work with {agentLabel}</div>
            <div className="mt-1 text-sm text-tertiary">
              {projectName
                ? `The task will run locally in ${projectName}. Agent-specific tools and permissions stay owned by ${agentLabel}.`
                : "Choose a local project before starting this Agent."}
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0 px-3 pb-3 pt-1">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl bg-background-primary-soft p-2 ring-[0.5px] ring-inset ring-border-subtle">
          <textarea
            aria-label={`Message ${agentLabel}`}
            className="max-h-48 min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-tertiary disabled:opacity-50"
            disabled={pending || !projectName}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              projectName ? `Describe a task for ${agentLabel}` : "Select a local project"
            }
            rows={1}
            value={draft}
          />
          <NodexButton
            aria-label={`Start ${agentLabel} task`}
            disabled={pending || !projectName || !draft.trim()}
            onClick={() => void submit()}
            size="icon-xs"
          >
            <UpArrowIcon />
          </NodexButton>
        </div>
        {error ? (
          <div className="mx-auto mt-1.5 w-full max-w-3xl px-1 text-xs text-danger" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
