import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import type { InboxEntryKind, InboxItem, InboxProposal } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import {
  ArchiveIcon,
  CheckmarkIcon,
  DispatchIcon,
  EditIcon,
  RetryIcon,
  AskAiIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  INBOX_ACTION_ICONS,
  InboxIconAction,
  InboxIconActions,
  type InboxIcon,
} from "./inbox-icon-action";
import { InboxKindControl } from "./inbox-kind-control";
import { InboxMessageEditor } from "./inbox-message-editor";
import { InboxOutcomeLine } from "./inbox-outcome";
import {
  INBOX_KIND_LABELS,
  describeInboxAction,
  describeInboxOutcome,
  inboxTriageModel,
} from "./inbox-presentation";
import {
  InboxDispatchEditor,
  draftFromAction,
  type InboxDispatchDraft,
} from "./inbox-dispatch-editor";
import type { InboxActions } from "./use-inbox-actions";

/** New strip content settles in place rather than popping. */
function Settle({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      className="flex flex-col gap-2"
    >
      {children}
    </motion.div>
  );
}

/** One line of the strip, or the action row beneath the card. */
function Row({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-6 items-center gap-2">{children}</div>;
}

function Notice({
  tone,
  children,
}: {
  readonly tone: "error" | "quiet";
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-[13px] leading-5 text-token-description-foreground">
      <span
        aria-hidden="true"
        className={cn(
          "mt-[7px] size-1.5 shrink-0 rounded-full",
          tone === "error" ? "bg-token-error-foreground" : "bg-token-description-foreground/50",
        )}
      />
      <span className="line-clamp-2 min-w-0">{children}</span>
    </div>
  );
}

function PromptPreview({ prompt }: { readonly prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
      className={cn(
        "cursor-interaction border-l-2 border-token-border pl-2.5 text-left text-[13px] leading-relaxed whitespace-pre-wrap text-token-description-foreground hover:text-token-foreground/80",
        !expanded && "line-clamp-2",
      )}
    >
      {prompt}
    </button>
  );
}

/** The decision the row asks for, always at the trailing edge where it is easy to find. */
function Decision({
  label,
  target,
  icon: Icon,
  variant = "primary",
  onClick,
}: {
  readonly label: string;
  /** The exact destination, revealed on hover so the strip never states it twice. */
  readonly target: string | null;
  readonly icon: InboxIcon;
  readonly variant?: "primary" | "ghost";
  readonly onClick: () => void;
}) {
  const button = (
    <NodexButton size="xs" variant={variant} className="shrink-0 gap-1.5" onClick={onClick}>
      <Icon className="icon-xs" />
      {label}
    </NodexButton>
  );
  return target ? (
    <NodexTooltip tooltipContent={target} side="top">
      {button}
    </NodexTooltip>
  ) : (
    button
  );
}

function SuggestionStrip({
  proposal,
  kind,
  onSetKind,
}: {
  readonly proposal: InboxProposal;
  readonly kind: InboxEntryKind | null;
  readonly onSetKind: (kind: InboxEntryKind | null) => void;
}) {
  const prompt =
    proposal.action.type === "new_chat" || proposal.action.type === "send_to_chat"
      ? proposal.action.prompt
      : null;
  const why = proposal.rationale
    ? `${proposal.rationale}${proposal.producedBy ? ` — ${proposal.producedBy}` : ""}`
    : proposal.producedBy;
  const summary = (
    <p className="min-w-0 text-sm leading-snug text-token-foreground">{proposal.summary}</p>
  );
  return (
    <div data-testid="inbox-suggestion" className="flex min-w-0 items-start gap-1.5">
      {kind ? <InboxKindControl kind={kind} onChange={onSetKind} /> : null}
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2", kind && "pt-0.5")}>
        {/* Why, and who suggested it, are a hover away rather than another line. */}
        {why ? (
          <NodexTooltip tooltipContent={why} side="top">
            {summary}
          </NodexTooltip>
        ) : (
          summary
        )}
        {prompt ? <PromptPreview prompt={prompt} /> : null}
      </div>
    </div>
  );
}

/** What a message's card holds beneath the message, and the row of ways to act under the card. */
export interface InboxTriageParts {
  /** Replaces the message's text while the user rewrites it; null otherwise. */
  readonly editor: ReactNode;
  /** What Nodex made of the message; null when there is nothing to say. */
  readonly strip: ReactNode;
  /** Icon actions and the menu, then the decision at the right; null while an editor is open. */
  readonly actions: ReactNode;
}

/**
 * What Nodex made of one message: a suggestion to decide, a reason it has none, or the way to
 * dispatch it by hand. Only a button here can make anything run. `Edit` rewrites the message
 * itself; dispatching by hand lives in the message menu.
 */
export function InboxTriage({
  item,
  projects,
  suggestionsEnabled,
  actions,
  manualDraft,
  groupedWithKey,
  menu,
  inboxProjectId,
  onManualDraftChange,
  onEditAsPage,
  children,
}: {
  readonly item: InboxItem;
  readonly projects: readonly Project[];
  /** The Project whose Inbox holds the message, or null for the Library Inbox. */
  readonly inboxProjectId: string | null;
  readonly suggestionsEnabled: boolean;
  readonly actions: InboxActions;
  /** A hand-written dispatch opened from the message menu. */
  readonly manualDraft: InboxDispatchDraft | null;
  /** Set when this message's suggestion is shown on a newer message of the same group. */
  readonly groupedWithKey: string | null;
  /** The message's menu, the first of the action row's icons. */
  readonly menu: ReactNode;
  readonly onManualDraftChange: (draft: InboxDispatchDraft | null) => void;
  /** Opens the message's Page, where a body too rich or long to rewrite in place is edited. */
  readonly onEditAsPage: () => void;
  /** Places the strip and the action row around the message. */
  readonly children: (parts: InboxTriageParts) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const model = inboxTriageModel(item, suggestionsEnabled);
  const message = item.body;
  const done = () => void actions.setState([item.pageId], "done");
  const keep = () => void actions.keep([item.pageId]);
  const dispatchByHand = () =>
    onManualDraftChange(
      draftFromAction({ type: "new_chat", projectId: inboxProjectId, prompt: message }, message),
    );
  const editAction = item.bodyEditable ? (
    <InboxIconAction label="Edit" icon={EditIcon} onClick={() => setEditing(true)} />
  ) : (
    <InboxIconAction label="Edit as Page" icon={EditIcon} onClick={onEditAsPage} />
  );
  const keepAction = <InboxIconAction label="Keep as a note" icon={ArchiveIcon} onClick={keep} />;
  const doneAction = <InboxIconAction label="Mark done" icon={CheckmarkIcon} onClick={done} />;
  const setKind = (kind: InboxEntryKind | null) => void actions.setKind(item.pageId, kind);
  // A kind, once known, leads every strip so it can be read and corrected in place.
  const kindControl = item.kind ? <InboxKindControl kind={item.kind} onChange={setKind} /> : null;
  const menuOnly = (
    <Row>
      <InboxIconActions>{menu}</InboxIconActions>
    </Row>
  );

  const parts = (): Omit<InboxTriageParts, "editor"> => {
    if (manualDraft) {
      return {
        strip: (
          <InboxDispatchEditor
            embedded
            initial={manualDraft}
            projects={projects}
            inboxProjectId={inboxProjectId}
            onCancel={() => onManualDraftChange(null)}
            onSubmit={(action) => actions.dispatch([item.pageId], action)}
          />
        ),
        actions: null,
      };
    }

    if (groupedWithKey && model.kind === "suggestion") {
      return {
        strip: (
          <span className="text-xs text-token-description-foreground">
            Suggested together with {groupedWithKey} below
          </span>
        ),
        actions: (
          <Row>
            <InboxIconActions>
              {menu}
              {editAction}
            </InboxIconActions>
          </Row>
        ),
      };
    }

    switch (model.kind) {
      case "suggesting":
        return {
          strip: (
            <span className="loading-shimmer-pure-text text-[13px]">Finding where this goes…</span>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {editAction}
                {doneAction}
              </InboxIconActions>
            </Row>
          ),
        };
      case "suggestion": {
        const proposal = model.proposal;
        const presentation = describeInboxAction(proposal.action, {
          targetProjectName: proposal.targetProjectName,
          chat: proposal.chat,
        });
        return {
          strip: (
            <Settle id={proposal.proposalId}>
              <SuggestionStrip
                proposal={proposal}
                kind={item.kind ?? proposal.kind}
                onSetKind={setKind}
              />
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {editAction}
                {proposal.action.type === "keep" ? null : keepAction}
                {doneAction}
              </InboxIconActions>
              <Decision
                label={presentation.verb}
                target={presentation.target}
                icon={INBOX_ACTION_ICONS[proposal.action.type]}
                onClick={() => void actions.confirm(proposal)}
              />
            </Row>
          ),
        };
      }
      case "suggestion-failed":
        return {
          strip: (
            <Settle id="suggestion-failed">
              <Row>
                {kindControl}
                <Notice tone="error">Couldn’t suggest — {model.message}</Notice>
              </Row>
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {editAction}
                <InboxIconAction
                  label="Retry"
                  icon={RetryIcon}
                  onClick={() => void actions.requestSuggestion([item.pageId])}
                />
                <InboxIconAction label="Dispatch…" icon={DispatchIcon} onClick={dispatchByHand} />
                {keepAction}
                {doneAction}
              </InboxIconActions>
            </Row>
          ),
        };
      case "dispatch-failed":
        return {
          strip: (
            <Settle id="dispatch-failed">
              <Row>
                {kindControl}
                <Notice tone="error">Couldn’t dispatch — {model.message}</Notice>
              </Row>
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                <InboxIconAction
                  label="Retry"
                  icon={RetryIcon}
                  onClick={() => void actions.retryDispatch(model.proposal.proposalId)}
                />
                <InboxIconAction
                  label="Dispatch…"
                  icon={DispatchIcon}
                  onClick={() =>
                    onManualDraftChange(draftFromAction(model.proposal.action, message))
                  }
                />
                {keepAction}
                {doneAction}
              </InboxIconActions>
            </Row>
          ),
        };
      case "undecided":
        return {
          // With nothing suggested, the card is the message alone, plus its kind once known.
          strip:
            kindControl && item.kind ? (
              <Row>
                {kindControl}
                <span className="text-[13px] text-token-description-foreground">
                  {INBOX_KIND_LABELS[item.kind]}
                </span>
              </Row>
            ) : null,
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {editAction}
                {suggestionsEnabled ? (
                  <InboxIconAction
                    label="Suggest"
                    icon={AskAiIcon}
                    onClick={() => void actions.requestSuggestion([item.pageId])}
                  />
                ) : null}
                {keepAction}
                {doneAction}
              </InboxIconActions>
              <Decision
                label="Dispatch…"
                target={null}
                icon={DispatchIcon}
                variant="ghost"
                onClick={dispatchByHand}
              />
            </Row>
          ),
        };
      case "handled":
        return {
          strip: <InboxOutcomeLine outcome={describeInboxOutcome(item)} />,
          actions: menuOnly,
        };
    }
  };

  // While the message is being rewritten, what Nodex made of the old text steps aside.
  if (editing) {
    return children({
      editor: (
        <InboxMessageEditor
          text={item.body}
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            const saved = await actions.edit(item.pageId, item.body, text);
            if (saved) setEditing(false);
            return saved;
          }}
        />
      ),
      strip: null,
      actions: null,
    });
  }
  return children({ editor: null, ...parts() });
}
