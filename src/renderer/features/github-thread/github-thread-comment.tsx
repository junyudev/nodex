import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  CopyIcon,
  DeleteIcon,
  EditIcon,
  MoreActionsIcon,
  SendToChatIcon,
} from "@/components/shared/icons";
import { WebsiteGitHubIcon } from "@/components/shared/icons/website-icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type {
  GitHubReactionContent,
  GitHubReactions,
  GitHubThreadCommand,
  GitHubThreadRef,
} from "../../../shared/github-thread";
import { GitHubMarkdownEditor } from "./github-thread-editor";
import {
  removeGitHubComment,
  toggleGitHubReaction,
  updateGitHubReactions,
} from "./github-thread-model";
import { GitHubMarkdown, useOpenOnGitHub } from "./github-thread-parts";
import { GitHubReactionPicker, GitHubReactionsBar } from "./github-thread-reactions";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

/** Long bodies, such as a bot's report, fold to this height until the reader asks for more. */
const FOLDED_HEIGHT_PX = 280;
/** Only bodies clearly taller than the fold fold: a few lines more are cheaper to just show. */
const FOLD_AFTER_PX = 420;

type EditTarget = Extract<GitHubThreadCommand, { type: "edit_comment" }>["target"];
type DeleteTarget = Extract<GitHubThreadCommand, { type: "delete_comment" }>["target"];

/** Something written on GitHub that the reader can act on in place. */
export interface GitHubWrittenItem {
  readonly id: string;
  readonly body: string;
  readonly url: string | null;
  readonly reactions: GitHubReactions | null;
  /** Present when the viewer may change the words. */
  readonly edit: EditTarget | null;
  /** Present when the viewer may delete it. */
  readonly remove: DeleteTarget | null;
}

/**
 * The state of one written item: being read, edited, or about to be deleted. The header's menu
 * and the body share it, so it lives with the entry that renders both.
 */
export function useGitHubWrittenItem(item: GitHubWrittenItem, run: GitHubThreadCommandRunner) {
  const [mode, setMode] = useState<"read" | "edit" | "confirm_delete">("read");
  const react = item.reactions
    ? (content: GitHubReactionContent, reacted: boolean) => {
        const subjectId = item.reactions?.subjectId;
        if (!subjectId) return;
        void run.run(
          { type: "react", subjectId, content, reacted },
          {
            optimistic: (detail) =>
              updateGitHubReactions(detail, subjectId, (reactions) =>
                toggleGitHubReaction(reactions, content, reacted),
              ),
          },
        );
      }
    : null;
  return {
    item,
    run,
    mode,
    setMode,
    react,
    startEditing: item.edit ? () => setMode("edit") : null,
    confirmDelete: item.remove ? () => setMode("confirm_delete") : null,
  };
}

export type GitHubWrittenItemState = ReturnType<typeof useGitHubWrittenItem>;

async function copyLink(url: string) {
  const intl = getIntl();
  if (await writeTextToClipboard(url))
    toast.success(
      intl.formatMessage({ id: "githubThread.copiedLink", defaultMessage: "Copied link" }),
    );
  else
    toast.danger(
      intl.formatMessage({
        id: "githubThread.copyLinkFailed",
        defaultMessage: "Couldn’t copy the link",
      }),
    );
}

/** The quiet actions at the end of an entry's header: hand it to the chat, or the menu. */
export function GitHubWrittenItemActions({
  state,
  onAddToChat,
  extra,
}: {
  readonly state: GitHubWrittenItemState;
  readonly onAddToChat: (() => void) | null;
  /** Actions of the entry itself, such as resolving a conversation, before the menu. */
  readonly extra?: ReactNode;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const { item } = state;
  const addLabel = intl.formatMessage({
    id: "githubThread.activity.addToChat",
    defaultMessage: "Add to chat",
  });
  const firstReaction =
    state.react && item.reactions?.viewerCanReact && item.reactions.groups.length === 0
      ? { reactions: item.reactions, toggle: state.react }
      : null;
  return (
    <>
      {extra}
      {firstReaction ? (
        <GitHubReactionPicker
          compact
          reactions={firstReaction.reactions}
          onToggle={firstReaction.toggle}
        />
      ) : null}
      {onAddToChat ? (
        <NodexIconButton
          size="xs"
          icon={SendToChatIcon}
          ariaLabel={addLabel}
          title={addLabel}
          onClick={onAddToChat}
        />
      ) : null}
      <NodexDropdownMenu
        align="end"
        triggerButton={
          <NodexIconButton
            size="xs"
            icon={MoreActionsIcon}
            ariaLabel={intl.formatMessage({
              id: "githubThread.comment.actions",
              defaultMessage: "Comment actions",
            })}
          />
        }
      >
        {item.url ? (
          <>
            <NodexDropdownItem
              leftSlot={<CopyIcon className="icon-xs" />}
              onSelect={() => item.url && void copyLink(item.url)}
            >
              <FormattedMessage id="githubThread.activity.copyLink" defaultMessage="Copy link" />
            </NodexDropdownItem>
            <NodexDropdownItem
              leftSlot={<WebsiteGitHubIcon className="icon-xs" />}
              onSelect={() => item.url && openOnGitHub(item.url)}
            >
              <FormattedMessage id="githubThread.openOnGitHub" defaultMessage="Open on GitHub" />
            </NodexDropdownItem>
          </>
        ) : null}
        {state.startEditing ? (
          <NodexDropdownItem
            leftSlot={<EditIcon className="icon-xs" />}
            onSelect={state.startEditing}
          >
            <FormattedMessage id="githubThread.comment.edit" defaultMessage="Edit" />
          </NodexDropdownItem>
        ) : null}
        {state.confirmDelete ? (
          <NodexDropdownItem
            tone="danger"
            leftSlot={<DeleteIcon className="icon-xs" />}
            onSelect={state.confirmDelete}
          >
            <FormattedMessage id="githubThread.comment.delete" defaultMessage="Delete" />
          </NodexDropdownItem>
        ) : null}
      </NodexDropdownMenu>
    </>
  );
}

/** The words of an entry: read (folded when long), edited in place, or confirmed for deletion. */
export function GitHubWrittenItemBody({
  state,
  thread,
  emptyText,
  fold = true,
}: {
  readonly state: GitHubWrittenItemState;
  readonly thread: GitHubThreadRef;
  /** Shown when there are no words; nothing is shown when absent. */
  readonly emptyText?: ReactNode;
  readonly fold?: boolean;
}) {
  const intl = useIntl();
  const { item, run, mode, setMode } = state;
  if (mode === "edit" && item.edit) {
    const target = item.edit;
    return (
      <GitHubMarkdownEditor
        initialValue={item.body}
        ariaLabel={intl.formatMessage({
          id: "githubThread.comment.editLabel",
          defaultMessage: "Edit comment",
        })}
        placeholder={intl.formatMessage({
          id: "githubThread.comment.editPlaceholder",
          defaultMessage: "Write something",
        })}
        onCancel={() => setMode("read")}
        actions={[
          {
            id: "save",
            label: intl.formatMessage({ id: "githubThread.editor.save", defaultMessage: "Save" }),
            // A review's own words may be emptied; a comment needs some.
            requiresText: target.kind !== "review",
            submit: async (body) => {
              const done = await run.run({ type: "edit_comment", target, body });
              if (done) setMode("read");
              return done;
            },
          },
        ]}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {item.body.trim() ? (
        fold ? (
          <GitHubFoldedContent>
            <GitHubMarkdown markdown={item.body} thread={thread} />
          </GitHubFoldedContent>
        ) : (
          <GitHubMarkdown markdown={item.body} thread={thread} />
        )
      ) : emptyText ? (
        <p className="text-sm text-token-description-foreground">{emptyText}</p>
      ) : null}
      {mode === "confirm_delete" && item.remove ? (
        <DeleteConfirmation
          onCancel={() => setMode("read")}
          onDelete={async () => {
            const target = item.remove;
            if (!target) return;
            const done = await run.run(
              { type: "delete_comment", target },
              { optimistic: (detail) => removeGitHubComment(detail, target.id) },
            );
            if (!done) setMode("read");
          }}
        />
      ) : null}
      {item.reactions ? (
        <GitHubReactionsBar reactions={item.reactions} onToggle={state.react} />
      ) : null}
    </div>
  );
}

function DeleteConfirmation({
  onCancel,
  onDelete,
}: {
  readonly onCancel: () => void;
  readonly onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div
      role="alert"
      className="flex min-h-9 items-center gap-2 rounded-lg bg-(--color-background-danger-surface) px-3 py-1 text-sm"
    >
      <span className="min-w-0 flex-1 text-danger">
        <FormattedMessage
          id="githubThread.comment.deleteConfirm"
          defaultMessage="Delete this comment from GitHub for everyone?"
        />
      </span>
      <NodexButton size="toolbar" variant="ghost" disabled={deleting} onClick={onCancel}>
        <FormattedMessage id="githubThread.editor.cancel" defaultMessage="Cancel" />
      </NodexButton>
      <NodexButton
        size="toolbar"
        variant="destructive"
        disabled={deleting}
        onClick={() => {
          setDeleting(true);
          void onDelete().finally(() => setDeleting(false));
        }}
      >
        <FormattedMessage id="githubThread.comment.delete" defaultMessage="Delete" />
      </NodexButton>
    </div>
  );
}

/**
 * Content taller than the fold shows its first part under a fade, with a way to see the rest.
 * Measuring keeps short content untouched; opening a disclosure inside it unfolds it.
 */
export function GitHubFoldedContent({ children }: { readonly children: ReactNode }) {
  const intl = useIntl();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setTall(content.scrollHeight > FOLD_AFTER_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    // A disclosure the reader opens deserves its full height. A `<details open>` in the content
    // also fires `toggle` as it renders, so only the reader's click on a summary counts.
    const unfold = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("summary")) setOpen(true);
    };
    content.addEventListener("click", unfold, true);
    return () => {
      observer.disconnect();
      content.removeEventListener("click", unfold, true);
    };
  }, []);
  const folded = tall && !open;
  return (
    <div className="flex flex-col">
      <div
        ref={contentRef}
        className={cn(
          "min-w-0",
          folded &&
            "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-64px),transparent)]",
        )}
        style={folded ? { maxHeight: FOLDED_HEIGHT_PX } : undefined}
      >
        {children}
      </div>
      {tall ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="cursor-interaction mt-1 self-start text-sm text-token-description-foreground hover:text-token-text-primary"
        >
          {open
            ? intl.formatMessage({ id: "githubThread.fold.less", defaultMessage: "Show less" })
            : intl.formatMessage({ id: "githubThread.fold.more", defaultMessage: "Show more" })}
        </button>
      ) : null}
    </div>
  );
}

export function GitHubPendingBadge({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center rounded-sm bg-token-charts-orange/10 px-1 text-xs text-token-charts-orange",
        className,
      )}
    >
      <FormattedMessage id="githubThread.comment.pending" defaultMessage="Pending" />
    </span>
  );
}
