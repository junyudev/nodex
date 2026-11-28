import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useState, type KeyboardEvent } from "react";
import { EditIcon } from "@/components/shared/icons";
import { PAGE_TITLE_TEXT_CLASS_NAME } from "@/components/block-documents/page-title-typography";
import { PageStageContentLayout } from "@/components/board/page-stage/frame";
import { NodexIconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GitHubThreadDetail, GitHubThreadLinks } from "../../../shared/github-thread";
import { GitHubThreadActivity } from "./github-thread-activity";
import { GitHubThreadComposer } from "./github-thread-composer";
import { GitHubMarkdownEditor } from "./github-thread-editor";
import {
  toggleGitHubReaction,
  updateGitHubReactions,
  type GitHubChatContextSubject,
} from "./github-thread-model";
import { GitHubMarkdown } from "./github-thread-parts";
import { GitHubThreadProperties } from "./github-thread-properties";
import {
  GitHubReactionPicker,
  GitHubReactionsBar,
  type GitHubReactionToggle,
} from "./github-thread-reactions";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

/** Title, where it stands, what it says, and what happened since: the thread in reading order. */
export function GitHubThreadOverview({
  detail,
  links,
  run,
  onShowFiles,
  onAddToChat,
  revealChecks,
}: {
  readonly detail: GitHubThreadDetail;
  readonly links: GitHubThreadLinks | null;
  readonly run: GitHubThreadCommandRunner;
  readonly onShowFiles: () => void;
  readonly onAddToChat: ((subject: GitHubChatContextSubject) => void) | null;
  readonly revealChecks: boolean;
}) {
  return (
    <PageStageContentLayout
      title={<GitHubThreadTitle detail={detail} run={run} />}
      properties={
        <GitHubThreadProperties
          detail={detail}
          links={links}
          run={run}
          onShowFiles={onShowFiles}
          onAddToChat={onAddToChat}
          revealChecks={revealChecks}
        />
      }
      body={
        <div className="flex flex-col gap-6">
          <GitHubThreadDescription detail={detail} run={run} />
          <GitHubThreadActivity detail={detail} run={run} onAddToChat={onAddToChat} />
          <GitHubThreadComposer detail={detail} run={run} />
        </div>
      }
    />
  );
}

/**
 * The title reads as a Page title and, for someone who may change it, edits like one: Enter or
 * leaving the field saves, Escape puts it back.
 */
function GitHubThreadTitle({
  detail,
  run,
}: {
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner;
}) {
  const intl = useIntl();
  const [draft, setDraft] = useState<string | null>(null);
  if (!detail.viewer.canEdit) {
    return (
      <h1 className={PAGE_TITLE_TEXT_CLASS_NAME} data-github-thread-title="">
        {detail.title}
      </h1>
    );
  }
  const value = draft ?? detail.title;
  const save = () => {
    if (draft === null) return;
    const title = draft.trim();
    setDraft(null);
    if (!title || title === detail.title) return;
    void run.run({ type: "edit", title }, { optimistic: (current) => ({ ...current, title }) });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
      // Blurring after the reset saves nothing.
      requestAnimationFrame(() => (event.target as HTMLTextAreaElement).blur());
    }
  };
  return (
    <h1 className="m-0" data-github-thread-title="">
      <textarea
        aria-label={intl.formatMessage({
          id: "githubThread.title.label",
          defaultMessage: "Title",
        })}
        rows={1}
        value={value}
        onChange={(event) => setDraft(event.currentTarget.value.replace(/\n/gu, " "))}
        onKeyDown={handleKeyDown}
        onBlur={save}
        spellCheck
        className={cn(
          PAGE_TITLE_TEXT_CLASS_NAME,
          "block w-full resize-none bg-transparent outline-none [field-sizing:content]",
        )}
      />
    </h1>
  );
}

function GitHubThreadDescription({
  detail,
  run,
}: {
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner;
}) {
  const intl = useIntl();
  const [editing, setEditing] = useState(false);
  const editLabel = intl.formatMessage({
    id: "githubThread.description.edit",
    defaultMessage: "Edit description",
  });
  const subjectId = detail.reactions.subjectId;
  const react: GitHubReactionToggle = (content, reacted) =>
    void run.run(
      { type: "react", subjectId, content, reacted },
      {
        optimistic: (current) =>
          updateGitHubReactions(current, subjectId, (reactions) =>
            toggleGitHubReaction(reactions, content, reacted),
          ),
      },
    );
  return (
    <div
      className="group/entry relative border-t-[0.5px] border-token-border pt-5"
      data-github-thread-description=""
    >
      {editing ? (
        <GitHubMarkdownEditor
          initialValue={detail.body}
          ariaLabel={editLabel}
          placeholder={intl.formatMessage({
            id: "githubThread.description.placeholder",
            defaultMessage: "Describe the change",
          })}
          onCancel={() => setEditing(false)}
          actions={[
            {
              id: "save",
              label: intl.formatMessage({ id: "githubThread.editor.save", defaultMessage: "Save" }),
              requiresText: false,
              submit: async (body) => {
                const done = await run.run(
                  { type: "edit", body },
                  { optimistic: (current) => ({ ...current, body }) },
                );
                if (done) setEditing(false);
                return done;
              },
            },
          ]}
        />
      ) : (
        <>
          <span className="absolute top-4 right-0 flex items-center gap-0.5 opacity-0 group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 has-[[aria-expanded=true]]:opacity-100">
            {detail.reactions.viewerCanReact && detail.reactions.groups.length === 0 ? (
              <GitHubReactionPicker compact reactions={detail.reactions} onToggle={react} />
            ) : null}
            {detail.viewer.canEdit ? (
              <NodexIconButton
                size="xs"
                icon={EditIcon}
                ariaLabel={editLabel}
                title={editLabel}
                onClick={() => setEditing(true)}
              />
            ) : null}
          </span>
          {detail.body.trim() ? (
            <GitHubMarkdown markdown={detail.body} thread={detail.ref} />
          ) : detail.viewer.canEdit ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="cursor-interaction text-sm text-token-description-foreground hover:text-token-text-primary"
            >
              <FormattedMessage
                id="githubThread.description.add"
                defaultMessage="Add a description"
              />
            </button>
          ) : (
            <p className="text-sm text-token-description-foreground">
              <FormattedMessage
                id="githubThread.description.empty"
                defaultMessage="No description."
              />
            </p>
          )}
          <GitHubReactionsBar className="mt-3" reactions={detail.reactions} onToggle={react} />
        </>
      )}
    </div>
  );
}
