import { useRef, useState, type KeyboardEvent } from "react";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexLogoMarkIcon, UpArrowIcon } from "@/components/shared/icons/app-icons";
import {
  activeMentionQuery,
  encodeCommentMentions,
  type MentionCandidate,
} from "../comment-mentions";
import { MemberAvatar } from "./member-avatar";

export interface DiscussionComposerSubmit {
  readonly bodyMarkdown: string;
  readonly toNodex: boolean;
}

export interface DiscussionComposerProps {
  readonly placeholder: string;
  readonly members: readonly MentionCandidate[];
  /** The "Send to Nodex" default, remembered per person and Page by the owner. */
  readonly sendToNodex: boolean;
  readonly onSendToNodexChange: (next: boolean) => void;
  readonly onSubmit: (submit: DiscussionComposerSubmit) => void;
  readonly onCancel?: () => void;
  readonly autoFocus?: boolean;
  readonly disabled?: boolean;
}

/**
 * A compact Comment field. `@` opens a mention list of Members and Nodex; choosing Nodex turns
 * on "Send to Nodex" instead of inserting text, because addressing Nodex is the Comment's intent,
 * not part of its words.
 */
export function DiscussionComposer({
  placeholder,
  members,
  sendToNodex,
  onSendToNodexChange,
  onSubmit,
  onCancel,
  autoFocus,
  disabled,
}: DiscussionComposerProps) {
  const intl = useIntl();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentioned, setMentioned] = useState<readonly MentionCandidate[]>([]);
  const [highlight, setHighlight] = useState(0);
  const query = activeMentionQuery(draft, caret);
  const options = query
    ? [
        { kind: "nodex" as const, id: "nodex", name: "Nodex" },
        ...members.map((member) => ({ kind: "member" as const, ...member })),
      ].filter((option) => option.name.toLowerCase().includes(query.text.toLowerCase()))
    : [];
  const menuOpen = options.length > 0;
  const canSubmit = draft.trim().length > 0 && !disabled;

  const choose = (option: (typeof options)[number]) => {
    if (!query) return;
    const before = draft.slice(0, query.start);
    const after = draft.slice(caret);
    const insert = option.kind === "nodex" ? "" : `@${option.name} `;
    const next = before + insert + after;
    setDraft(next);
    if (option.kind === "nodex") onSendToNodexChange(true);
    else setMentioned((current) => [...current.filter((m) => m.id !== option.id), option]);
    const nextCaret = before.length + insert.length;
    setCaret(nextCaret);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(nextCaret, nextCaret));
  };

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      bodyMarkdown: encodeCommentMentions(draft.trim(), mentioned),
      toNodex: sendToNodex,
    });
    setDraft("");
    setMentioned([]);
    setCaret(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((index) => (index + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(options[Math.min(highlight, options.length - 1)]!);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (draft) setDraft("");
      else onCancel?.();
    }
  };

  return (
    <div
      className="relative flex items-end gap-1.5"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <NodexTooltip
        tooltipContent={intl.formatMessage(
          sendToNodex
            ? { id: "pageDiscussions.composer.nodexOn", defaultMessage: "Nodex will answer this" }
            : { id: "pageDiscussions.composer.nodexOff", defaultMessage: "Send to Nodex" },
        )}
        side="top"
      >
        <button
          type="button"
          aria-pressed={sendToNodex}
          aria-label={intl.formatMessage({
            id: "pageDiscussions.composer.sendToNodex",
            defaultMessage: "Send to Nodex",
          })}
          onClick={() => onSendToNodexChange(!sendToNodex)}
          className={cn(
            "mb-0.5 flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-full",
            sendToNodex
              ? "bg-token-foreground/10 text-token-foreground"
              : "text-token-description-foreground hover:bg-token-foreground/5",
          )}
        >
          <NodexLogoMarkIcon className="size-3.5" monochrome />
        </button>
      </NodexTooltip>
      <textarea
        ref={inputRef}
        rows={1}
        autoFocus={autoFocus}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          setDraft(event.target.value);
          setCaret(event.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className="max-h-40 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-5 outline-none [field-sizing:content] placeholder:text-token-description-foreground"
      />
      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        aria-label={intl.formatMessage({
          id: "pageDiscussions.composer.send",
          defaultMessage: "Send",
        })}
        className="mb-0.5 flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-full bg-composer-primary text-composer-primary disabled:cursor-default disabled:opacity-40"
      >
        <UpArrowIcon className="size-3.5" />
      </button>
      {menuOpen ? (
        <div
          role="listbox"
          aria-label={intl.formatMessage({
            id: "pageDiscussions.composer.mentionList",
            defaultMessage: "Mention",
          })}
          className="absolute bottom-full left-6 z-10 mb-1 flex w-48 flex-col rounded-xl bg-token-dropdown-background/90 p-1 text-sm shadow-lg ring-[0.5px] ring-token-border backdrop-blur-xl"
        >
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === highlight}
              onPointerDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              className={cn(
                "flex h-7 items-center gap-2 rounded-lg px-2 text-left",
                index === highlight && "bg-token-list-hover-background",
              )}
            >
              {option.kind === "nodex" ? (
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <NodexLogoMarkIcon className="size-3.5" monochrome />
                </span>
              ) : (
                <MemberAvatar memberId={option.id} name={option.name} size={16} />
              )}
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.kind === "nodex" ? (
                <span className="shrink-0 text-xs text-token-description-foreground">
                  <FormattedMessage id="pageDiscussions.composer.agent" defaultMessage="Agent" />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
