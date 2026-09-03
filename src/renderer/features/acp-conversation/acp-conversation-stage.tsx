import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { StopIcon, UpArrowIcon } from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  type NodexOptionPickerOption,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import type {
  AcpBackendSessionPresentation,
  AcpCanonicalSessionUpdate,
  AcpConversationSnapshot,
  AcpConversationTurn,
} from "../../../shared/acp-conversation";
import { AcpConversationOwner, type AcpConversationOwnerPort } from "./acp-conversation-owner";
import { BudgetedMarkdownRenderer } from "../local-conversation/view/shared/markdown/budgeted-markdown-renderer";
import {
  sessionFirstSubmissionOwner,
  type SessionFirstSubmission,
} from "../conversation-launch/session-first-submission-owner";
import { useSessionFirstSubmission } from "../conversation-launch/use-session-first-submission";

export interface AcpConversationStageProps {
  readonly threadId: string;
  readonly agentLabel?: string;
  readonly cwd?: string | null;
  readonly projectWorkspacePath?: string | null;
}

interface AcpConversationStageViewProps extends Omit<AcpConversationStageProps, "threadId"> {
  readonly owner: AcpConversationOwnerPort;
  readonly threadId?: string;
  readonly firstSubmission?: SessionFirstSubmission | null;
}

type AcpSessionConfigOption = AcpBackendSessionPresentation["configOptions"][number];

const statusLabel: Record<AcpConversationSnapshot["status"], string> = {
  idle: "Ready",
  running: "Working",
  "authentication-required": "Authentication required",
  failed: "Failed",
  closed: "Closed",
};

const statusClassName: Record<AcpConversationSnapshot["status"], string> = {
  idle: "semantic-text-secondary",
  running: "text-info",
  "authentication-required": "text-warning",
  failed: "text-danger",
  closed: "text-tertiary",
};

const toolStatusClassName: Record<
  Extract<AcpCanonicalSessionUpdate, { kind: "tool-call" }>["status"],
  string
> = {
  pending: "text-tertiary",
  in_progress: "text-info",
  completed: "semantic-text-secondary",
  failed: "text-danger",
};

const toolStatusLabel: Record<
  Extract<AcpCanonicalSessionUpdate, { kind: "tool-call" }>["status"],
  string
> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Completed",
  failed: "Failed",
};

const assertNever = (value: never): never => {
  throw new TypeError(`Unhandled ACP presentation update: ${JSON.stringify(value)}`);
};

const configSelectOptions = (
  option: AcpSessionConfigOption,
): readonly NodexOptionPickerOption[] => {
  if (option.type !== "select") return [];
  return option.options.flatMap((candidate) =>
    "group" in candidate
      ? candidate.options.map((entry) => ({
          value: entry.value,
          label: entry.name,
          subText: entry.description ?? undefined,
          searchText: `${candidate.name} ${entry.name}`,
        }))
      : [
          {
            value: candidate.value,
            label: candidate.name,
            subText: candidate.description ?? undefined,
          },
        ],
  );
};

function AcpMessageUpdate({
  update,
  cwd,
  projectWorkspacePath,
}: {
  readonly update: Extract<AcpCanonicalSessionUpdate, { kind: "message" }>;
  readonly cwd?: string | null;
  readonly projectWorkspacePath?: string | null;
}) {
  if (update.role === "thought") {
    return (
      <div className="border-default border-l-[0.5px] pl-2.5 text-sm text-tertiary">
        <div className="mb-0.5 text-xs">Thinking</div>
        <div className="whitespace-pre-wrap">{update.text}</div>
      </div>
    );
  }
  if (update.role === "compaction") {
    return (
      <div className="border-default border-l-[0.5px] pl-2.5 text-sm semantic-text-secondary">
        <div className="mb-0.5 text-xs text-tertiary">Context summary</div>
        <div className="whitespace-pre-wrap">{update.text}</div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "min-w-0 text-sm text-foreground",
        update.role === "user" && "rounded-lg bg-text/10 px-3 py-2",
      )}
      data-acp-message-role={update.role}
    >
      <BudgetedMarkdownRenderer
        content={update.text}
        parseIncompleteMarkdown
        sourceAriaLabel={`${update.role === "user" ? "User" : "Agent"} message source`}
        sourceIdentity={update.key}
        cwd={cwd}
        projectWorkspacePath={projectWorkspacePath}
      />
    </div>
  );
}

function AcpToolCallUpdate({
  update,
}: {
  readonly update: Extract<AcpCanonicalSessionUpdate, { kind: "tool-call" }>;
}) {
  return (
    <div className="border-default flex min-w-0 flex-col gap-1 border-l-[0.5px] pl-2.5 text-sm">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-foreground">{update.title}</span>
        <span className={cn("shrink-0 text-xs", toolStatusClassName[update.status])}>
          {toolStatusLabel[update.status]}
        </span>
      </div>
      {update.detail ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs semantic-text-secondary">
          {update.detail}
        </pre>
      ) : null}
      {update.locations.length > 0 ? (
        <div className="truncate text-xs text-tertiary">{update.locations.join(" · ")}</div>
      ) : null}
    </div>
  );
}

function AcpPlanUpdate({
  update,
}: {
  readonly update: Extract<AcpCanonicalSessionUpdate, { kind: "plan" }>;
}) {
  if (update.state === "removed") {
    return <div className="text-xs text-tertiary">Plan cleared</div>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <div className="text-xs text-tertiary">Plan</div>
      {update.markdown ? <div className="whitespace-pre-wrap">{update.markdown}</div> : null}
      {update.entries.map((entry, index) => (
        <div className="flex min-w-0 items-start gap-2" key={`${update.key}:${index}`}>
          <span
            className={cn(
              "mt-[7px] size-1.5 shrink-0 rounded-full",
              entry.status === "in_progress"
                ? "bg-text-info"
                : entry.status === "completed"
                  ? "bg-token-foreground/35"
                  : "bg-token-foreground/15",
            )}
          />
          <span
            className={cn(
              "min-w-0",
              entry.status === "completed" && "semantic-text-secondary line-through",
            )}
          >
            {entry.content}
          </span>
        </div>
      ))}
    </div>
  );
}

function AcpMetadataUpdate({ update }: { readonly update: AcpCanonicalSessionUpdate }) {
  switch (update.kind) {
    case "mode":
      return <div className="text-xs text-tertiary">Mode changed to {update.currentModeId}</div>;
    case "config":
      return (
        <div className="text-xs text-tertiary">
          Session configuration updated
          {update.optionIds.length ? ` · ${update.optionIds.join(", ")}` : ""}
        </div>
      );
    case "session-info":
      return update.title || update.updatedAt ? (
        <div className="text-xs text-tertiary">
          {[update.title, update.updatedAt].filter(Boolean).join(" · ")}
        </div>
      ) : null;
    case "usage": {
      const percentage =
        update.size > 0 ? Math.min(100, Math.round((update.used / update.size) * 100)) : 0;
      return (
        <div className="flex items-center gap-2 text-xs text-tertiary">
          <span>Context {percentage}%</span>
          {update.cost ? (
            <span>
              {update.cost.amount} {update.cost.currency}
            </span>
          ) : null}
        </div>
      );
    }
    case "commands":
      return update.commands.length ? (
        <div className="text-xs text-tertiary">
          Commands available · {update.commands.map(({ name }) => name).join(", ")}
        </div>
      ) : null;
    case "compaction":
      return (
        <div className={cn("text-xs", update.error ? "text-danger" : "text-tertiary")}>
          Context compaction · {update.status}
          {update.error ? ` · ${update.error}` : ""}
        </div>
      );
    case "message":
    case "tool-call":
    case "plan":
      return null;
    default:
      return assertNever(update);
  }
}

function AcpTurn({
  turn,
  cwd,
  projectWorkspacePath,
}: {
  readonly turn: AcpConversationTurn;
  readonly cwd?: string | null;
  readonly projectWorkspacePath?: string | null;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Conversation turn">
      {turn.promptText ? (
        <div
          className="ml-auto max-w-[85%] rounded-lg bg-text/10 px-3 py-2 text-sm whitespace-pre-wrap text-foreground"
          data-user-message-bubble="true"
        >
          {turn.promptText}
        </div>
      ) : null}
      {turn.updates.map((update) => {
        if (update.kind === "message") {
          return (
            <AcpMessageUpdate
              key={update.key}
              update={update}
              cwd={cwd}
              projectWorkspacePath={projectWorkspacePath}
            />
          );
        }
        if (update.kind === "tool-call")
          return <AcpToolCallUpdate key={update.key} update={update} />;
        if (update.kind === "plan") return <AcpPlanUpdate key={update.key} update={update} />;
        return <AcpMetadataUpdate key={update.key} update={update} />;
      })}
      {turn.stopReason && turn.stopReason !== "end_turn" ? (
        <div className="text-xs text-tertiary">Turn stopped · {turn.stopReason}</div>
      ) : null}
    </section>
  );
}

function AcpModeControl({
  presentation,
  disabled,
  onChange,
}: {
  readonly presentation: AcpBackendSessionPresentation;
  readonly disabled: boolean;
  readonly onChange: (modeId: string) => void;
}) {
  const modes = presentation.modes;
  if (!modes || modes.availableModes.length < 2) return null;
  const current = modes.availableModes.find(({ id }) => id === modes.currentModeId);
  return (
    <NodexOptionPicker
      disabled={disabled}
      value={modes.currentModeId}
      options={modes.availableModes.map((mode) => ({
        value: mode.id,
        label: mode.name,
        subText: mode.description ?? undefined,
      }))}
      onValueChange={onChange}
      triggerButton={
        <NodexDropdownButtonTrigger chrome="transparent" muted size="xs">
          <span className="truncate">{current?.name ?? modes.currentModeId}</span>
        </NodexDropdownButtonTrigger>
      }
    />
  );
}

function AcpCapabilitySummary({
  presentation,
}: {
  readonly presentation: AcpBackendSessionPresentation;
}) {
  const { prompt, session } = presentation.capabilities;
  const labels = [
    "Text",
    prompt.resourceLink ? "Links" : null,
    prompt.image ? "Images" : null,
    prompt.audio ? "Audio" : null,
    prompt.embeddedContext ? "Embedded context" : null,
    session.load ? "History" : null,
    session.resume ? "Resume" : null,
    session.unstableFork ? "Fork" : null,
    session.additionalDirectories ? "Additional folders" : null,
  ].filter((label): label is string => label !== null);
  return (
    <span aria-label="Agent capabilities" className="min-w-0 truncate text-xs text-tertiary">
      {labels.join(" · ")}
    </span>
  );
}

function AcpConfigControl({
  option,
  disabled,
  onChange,
}: {
  readonly option: AcpSessionConfigOption;
  readonly disabled: boolean;
  readonly onChange: (value: string | boolean) => void;
}) {
  if (option.type === "boolean") {
    return (
      <label className="flex items-center gap-1.5 text-xs text-tertiary">
        <span className="max-w-32 truncate">{option.name}</span>
        <NodexSwitch
          ariaLabel={option.name}
          checked={option.currentValue}
          disabled={disabled}
          onCheckedChange={onChange}
          size="compact"
        />
      </label>
    );
  }
  const options = configSelectOptions(option);
  const current = options.find(({ value }) => value === option.currentValue);
  return (
    <NodexOptionPicker
      disabled={disabled}
      value={option.currentValue}
      options={options}
      search={options.length > 8 ? "filter" : "none"}
      onValueChange={onChange}
      triggerButton={
        <NodexDropdownButtonTrigger chrome="transparent" muted size="xs">
          <span className="truncate">
            {option.name}: {current?.label ?? option.currentValue}
          </span>
        </NodexDropdownButtonTrigger>
      }
    />
  );
}

export function AcpConversationStageView({
  owner,
  firstSubmission = null,
  agentLabel = "ACP Agent",
  cwd,
  projectWorkspacePath,
}: AcpConversationStageViewProps) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const [draft, setDraft] = useState("");

  useEffect(() => owner.connect(), [owner]);

  const presentation = state.presentation;
  const snapshot = presentation?.snapshot ?? null;
  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    if (await owner.prompt(prompt)) setDraft("");
  };
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.shiftKey || event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };

  if (state.connection === "connecting" && !presentation) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center text-sm text-tertiary"
        role="status"
      >
        Connecting to {agentLabel}…
      </div>
    );
  }

  if (state.connection === "failed" && !presentation) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm text-danger">Could not open {agentLabel}</div>
        <div className="max-w-lg text-xs text-tertiary">{state.error}</div>
        <NodexButton size="xs" variant="secondary" onClick={owner.retry}>
          Retry
        </NodexButton>
      </div>
    );
  }

  if (!presentation || !snapshot) return null;
  const isRunning = snapshot.status === "running";
  const controlsDisabled = state.controlPending !== null || snapshot.status === "closed";
  const canPrompt = snapshot.status === "idle" && !state.promptPending;
  const authMethods = presentation.capabilities.authMethods.filter(({ kind }) => kind === "agent");

  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary text-foreground">
      <header className="border-default flex min-h-10 shrink-0 items-center gap-2 border-b-[0.5px] px-3">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{agentLabel}</span>
        <span className={cn("shrink-0 text-xs", statusClassName[snapshot.status])} role="status">
          {statusLabel[snapshot.status]}
        </span>
        <AcpCapabilitySummary presentation={presentation} />
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {state.connection === "failed" || snapshot.status === "failed" ? (
            <NodexButton size="xs" variant="secondary" onClick={owner.retry}>
              Retry
            </NodexButton>
          ) : null}
          <AcpModeControl
            presentation={presentation}
            disabled={controlsDisabled}
            onChange={(modeId) => void owner.setMode(modeId)}
          />
          {presentation.configOptions.map((option) => (
            <AcpConfigControl
              key={option.id}
              option={option}
              disabled={controlsDisabled}
              onChange={(value) => void owner.setConfigOption(option.id, value)}
            />
          ))}
          {authMethods.map((method) => (
            <NodexButton
              key={method.id}
              disabled={controlsDisabled}
              onClick={() => void owner.authenticate(method.id)}
              size="xs"
              variant="secondary"
            >
              {method.name}
            </NodexButton>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-label={`${agentLabel} conversation`}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5">
          {firstSubmission ? (
            <div
              className="ml-auto max-w-[85%] rounded-lg bg-text/10 px-3 py-2 text-sm whitespace-pre-wrap text-foreground"
              data-client-user-message-id={firstSubmission.clientUserMessageId}
              data-user-message-bubble="true"
            >
              {firstSubmission.prompt}
            </div>
          ) : null}
          {snapshot.turns.length === 0 && !firstSubmission ? (
            <div className="py-10 text-center text-sm text-tertiary">
              Start a conversation with {agentLabel}.
            </div>
          ) : (
            snapshot.turns.map((turn, index) => (
              <AcpTurn
                key={`${snapshot.sessionId}:${turn.sequence ?? `replay-${index}`}`}
                turn={turn}
                cwd={cwd}
                projectWorkspacePath={projectWorkspacePath}
              />
            ))
          )}
          {snapshot.error ? <div className="text-sm text-danger">{snapshot.error}</div> : null}
        </div>
      </div>

      <div className="shrink-0 px-3 pb-3 pt-1">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl bg-background-primary-soft p-2 ring-[0.5px] ring-inset ring-border-subtle">
          <textarea
            aria-label={`Message ${agentLabel}`}
            className="max-h-48 min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-tertiary disabled:opacity-50"
            disabled={!canPrompt && !isRunning}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              snapshot.status === "closed"
                ? "Session closed"
                : snapshot.status === "authentication-required"
                  ? `Authenticate ${agentLabel} to continue`
                  : `Message ${agentLabel}`
            }
            rows={1}
            value={draft}
          />
          {isRunning ? (
            <NodexButton
              aria-label="Stop Agent"
              disabled={state.controlPending === "cancel"}
              onClick={() => void owner.cancel()}
              size="icon-xs"
            >
              <StopIcon />
            </NodexButton>
          ) : (
            <NodexButton
              aria-label="Send message"
              disabled={!canPrompt || !draft.trim()}
              onClick={() => void submit()}
              size="icon-xs"
            >
              <UpArrowIcon />
            </NodexButton>
          )}
        </div>
        {state.error ? (
          <div className="mx-auto mt-1.5 w-full max-w-3xl px-1 text-xs text-danger">
            {state.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AcpConversationStage(props: AcpConversationStageProps) {
  return <AcpConversationStageSession key={props.threadId} {...props} />;
}

function AcpConversationStageSession({ threadId, ...props }: AcpConversationStageProps) {
  const [owner] = useState(() => new AcpConversationOwner(threadId));
  const firstSubmission = useSessionFirstSubmission({
    projectId: null,
    sessionId: null,
    threadId,
  });
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
    .presentation?.snapshot;
  const canonicalFirstSubmissionVisible = Boolean(
    firstSubmission &&
    snapshot?.turns.some(
      (turn) => turn.clientUserMessageId === firstSubmission.clientUserMessageId,
    ),
  );
  useEffect(() => {
    if (!firstSubmission || !canonicalFirstSubmissionVisible) return;
    sessionFirstSubmissionOwner.complete(firstSubmission.launchId);
  }, [canonicalFirstSubmissionVisible, firstSubmission]);
  return (
    <AcpConversationStageView
      owner={owner}
      threadId={threadId}
      firstSubmission={canonicalFirstSubmissionVisible ? null : firstSubmission}
      {...props}
    />
  );
}
