import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TextSelection } from "@tiptap/pm/state";
import { getIntl } from "@/lib/i18n";
import { toastFailure } from "@/lib/failure-toast";
import { useClockAt } from "@/lib/use-clock-at";
import { useMemberDirectory } from "@/lib/members-runtime";
import { usePageDiscussions } from "@/lib/use-page-discussions";
import { usePageBlockWriters } from "@/lib/use-page-block-writers";
import { rendererSpace } from "@/lib/renderer-space";
import type { NfmPageAskSubmission } from "@/components/board/editor/nfm-page-ask";
import type {
  NfmDiscussionStartKind,
  NfmDiscussionsEditor,
  NfmPageDiscussionsBinding,
} from "@/components/board/editor/nfm-page-discussions-capability";
import {
  EMPTY_DISCUSSION_MARKS_PRESENTATION,
  NFM_DISCUSSION_ACTIVATE_EVENT,
  nfmDiscussionMarksPluginKey,
  setNfmDiscussionMarksPresentation,
  type NfmDiscussionActivateDetail,
} from "@/components/board/editor/nfm-discussion-marks-extension";
import {
  contentRoutingContextKey,
  type ContentRoutingContext,
} from "../../../shared/content-routing-context";
import type { DiscussionCommand } from "../../../shared/discussions";
import type { Actor } from "../../../shared/actor";
import { writeMarkdown } from "../../../shared/nodex-markdown";
import { createUuidV7 } from "../../../shared/uuid-v7";
import {
  escapeAttributeValue,
  findBlockElementById,
} from "@/components/board/editor/block-dom-selectors";
import { createInPlaceAskCommand, pageAskAgentFromConfig } from "../../../shared/page-ask";
import type { DiscussionComposerSubmit } from "./view/discussion-composer";
import type { DiscussionCardActions } from "./view/discussion-card";
import type { MentionCandidate } from "./comment-mentions";
import type { DiscussionAnchorView, DiscussionView } from "./discussion-view-model";
import { projectDiscussions } from "./project-discussions";
import { subscribeDiscussionReveal, takeDiscussionReveal } from "./discussion-reveal";
import { blockTextRange } from "./selection-anchor";
import type { SuggestionHunk } from "./suggestion-hunks";
import { useSuggestionSession, type SuggestionSession } from "./use-suggestion-session";

/** A selection being commented on before its Discussion exists. */
export interface DiscussionDraft {
  readonly kind: Exclude<NfmDiscussionStartKind, "check">;
  readonly quote: string;
  readonly blockId: string;
  readonly blockIds: readonly string[];
}

export interface PageDiscussionsController {
  readonly views: readonly DiscussionView[];
  readonly loading: boolean;
  readonly nowMs: number;
  readonly editor: NfmDiscussionsEditor | null;
  readonly activeId: string | null;
  readonly setActiveId: (discussionId: string | null) => void;
  readonly draft: DiscussionDraft | null;
  readonly cancelDraft: () => void;
  readonly submitDraft: (submit: DiscussionComposerSubmit) => void;
  readonly reply: (discussionId: string, submit: DiscussionComposerSubmit) => void;
  readonly actions: DiscussionCardActions;
  readonly members: readonly MentionCandidate[];
  readonly sendToNodex: boolean;
  readonly setSendToNodex: (next: boolean) => void;
  readonly nodexAnswersQuestions: boolean;
  readonly setNodexAnswersQuestions: (next: boolean) => void;
  /** Whether the person may change the Page directly; Commenters only suggest. */
  readonly canEditPage: boolean;
  /** Edits become Suggested edits: always for Commenters, by choice for editors. */
  readonly suggesting: boolean;
  readonly setSuggestMode: (next: boolean) => void;
  readonly suggestion: SuggestionSession | null;
  readonly submitSuggestions: () => void;
  readonly discardSuggestions: () => void;
  /** Who last wrote a Block, for attributing Nodex's writes to the Ask that made them. */
  readonly writerOf: (blockId: string) => BlockWriter | null;
  readonly memberName: (memberId: string) => string | null;
  /** Starts a Discussion on a whole Visual or one of its data points. */
  readonly createAnchoredDiscussion: (input: {
    readonly anchor: Exclude<DiscussionAnchorView, { kind: "text" }>;
    readonly body: string;
    readonly toNodex: boolean;
    readonly askKind?: "ask" | "check_page";
  }) => void;
  /** Proposes a new source for a Visual code block instead of writing it. */
  readonly suggestVisualSource: (blockId: string, originalSource: string, source: string) => void;
  readonly binding: NfmPageDiscussionsBinding;
}

export interface BlockWriter {
  readonly actor: Actor;
  readonly writtenAtMs: number;
}

const COMMENT_MARK = "comment";

function addCommentMark(
  editor: NfmDiscussionsEditor,
  from: number,
  to: number,
  id: string,
): boolean {
  const markType = editor.prosemirrorState.schema.marks[COMMENT_MARK];
  if (!markType || from >= to) return false;
  // Collapsing the selection to the end closes the selection menu that started the Discussion.
  editor.transact((transaction) =>
    transaction
      .addMark(from, to, markType.create({ threadId: id }))
      .setSelection(TextSelection.create(transaction.doc, to)),
  );
  return true;
}

/** Removes a Discussion's marks wherever they are, for a creation Core refused. */
function removeCommentMark(editor: NfmDiscussionsEditor, id: string): void {
  const markType = editor.prosemirrorState.schema.marks[COMMENT_MARK];
  if (!markType) return;
  editor.transact((transaction) => {
    transaction.doc.descendants((node, position) => {
      if (!node.isText) return true;
      for (const mark of node.marks) {
        if (mark.type === markType && mark.attrs.threadId === id) {
          transaction.removeMark(position, position + node.nodeSize, mark);
        }
      }
      return false;
    });
    return transaction;
  });
}

function draftRange(editor: NfmDiscussionsEditor): { from: number; to: number } | null {
  return nfmDiscussionMarksPluginKey.getState(editor.prosemirrorState)?.presentation.draft ?? null;
}

/** The default for "Send to Nodex": on when nobody else could answer, off in a team Space. */
const defaultSendToNodex = (): boolean => rendererSpace().kind !== "team";

/**
 * Owns one Page's Discussions in the renderer: the live read model, which Discussion is active,
 * the selection being commented on, the decorations on marked text, in-place Asks, and every
 * action a card offers. Rendering lives in the views; this hook holds intent and commands.
 */
export function usePageDiscussionsController({
  contentRoutingContext,
  pageId,
  besideSessionId,
  onOpenSession,
  flushDocument,
}: {
  readonly contentRoutingContext: ContentRoutingContext;
  readonly pageId: string;
  /** The conversation this Page is shown beside, where the person's Asks should run. */
  readonly besideSessionId: string | null;
  readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
  /** Delivers local edits to Core, so a command can refer to Blocks the person just created. */
  readonly flushDocument: () => Promise<void>;
}): PageDiscussionsController {
  const query = usePageDiscussions(contentRoutingContext, pageId);
  const { error, fetching, hasMore, loadMore } = query;
  const loadedCount = query.discussions?.length;
  useEffect(() => {
    if (loadedCount === undefined || !hasMore || fetching || error) return;
    void loadMore({ cancelRefetch: false });
  }, [error, fetching, hasMore, loadedCount, loadMore]);
  const writers = usePageBlockWriters(contentRoutingContext, pageId).data;
  const writerMap = useMemo(
    () =>
      new Map(
        (writers ?? []).map((writer) => [
          writer.blockId,
          { actor: writer.actor, writtenAtMs: Date.parse(writer.writtenAt) || 0 },
        ]),
      ),
    [writers],
  );
  const directory = useMemberDirectory().data;
  const [nowMs, setNowMs] = useState(Date.now);
  useClockAt(nowMs + 60_000, setNowMs);
  const [editor, setEditor] = useState<NfmDiscussionsEditor | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DiscussionDraft | null>(null);
  const [sendToNodex, setSendToNodex] = useState(defaultSendToNodex);
  const [suggestMode, setSuggestMode] = useState(false);

  const self = directory?.find((member) => member.isCurrentMember) ?? null;
  const canEditPage = self ? self.role !== "commenter" : true;
  const suggesting = suggestMode || !canEditPage;
  const memberName = useCallback(
    (memberId: string) => directory?.find((member) => member.id === memberId)?.displayName ?? null,
    [directory],
  );
  const views = useMemo(
    () =>
      projectDiscussions(query.discussions ?? [], {
        selfMemberId: self?.id ?? null,
        memberName,
        canEditPage,
        nowMs,
      }),
    [canEditPage, memberName, nowMs, query.discussions, self?.id],
  );
  const members = useMemo(
    () =>
      (directory ?? [])
        .filter((member) => member.lifecycle === "active" && !member.isCurrentMember)
        .map((member) => ({ id: member.id, name: member.displayName })),
    [directory],
  );

  // Commands go through the latest query owner; refs keep the binding's functions stable.
  const commandRoute = contentRoutingContextKey(contentRoutingContext);
  const executeRef = useRef({ route: commandRoute, execute: query.execute });
  const editorRef = useRef(editor);
  const besideSessionRef = useRef(besideSessionId);
  const viewsRef = useRef(views);
  const flushRef = useRef(flushDocument);
  const suggestingRef = useRef(suggesting);
  useLayoutEffect(() => {
    flushRef.current = flushDocument;
    suggestingRef.current = suggesting;
    executeRef.current = { route: commandRoute, execute: query.execute };
    editorRef.current = editor;
    besideSessionRef.current = besideSessionId;
    viewsRef.current = views;
  });

  const run = useCallback(async (command: DiscussionCommand, failure: string) => {
    try {
      return await executeRef.current.execute(command);
    } catch (error) {
      toastFailure(failure, error);
      return null;
    }
  }, []);

  const createTextDiscussion = useCallback(
    async (input: {
      readonly from: number;
      readonly to: number;
      readonly quote: string;
      readonly blockId: string;
      readonly blockIds: readonly string[];
      readonly body: string;
      readonly toNodex: boolean;
      readonly askKind: "ask" | "check" | null;
    }) => {
      const current = editorRef.current;
      if (!current) return;
      const discussionId = createUuidV7();
      // While suggesting, the Page is not written locally: Core marks a one-Block selection
      // itself, and a selection across Blocks anchors on those Blocks.
      const semantic = suggestingRef.current;
      const range = semantic
        ? blockTextRange(current.prosemirrorState, input.from, input.to)
        : null;
      if (!semantic && !addCommentMark(current, input.from, input.to, discussionId)) return;
      const anchor = range
        ? ({ kind: "text", blockId: range.blockId } as const)
        : semantic
          ? ({ kind: "blocks", blockIds: input.blockIds } as const)
          : ({ kind: "text", blockId: input.blockId } as const);
      setActiveId(discussionId);
      const result = await run(
        {
          kind: "create",
          pageId,
          discussionId,
          firstCommentId: createUuidV7(),
          anchor,
          ...(range
            ? {
                textRange: {
                  from: range.from,
                  to: range.to,
                  expectedText: range.expectedText,
                },
              }
            : anchor.kind === "text"
              ? { quote: input.quote.slice(0, 500) }
              : {}),
          firstComment: {
            body: input.body,
            toNodex: input.toNodex,
            ...(input.toNodex ? { askKind: input.askKind ?? "ask" } : {}),
            ...(input.toNodex && besideSessionRef.current
              ? { requestedSessionId: besideSessionRef.current }
              : {}),
          },
        },
        getIntl().formatMessage({
          id: "pageDiscussions.controller.createFailed",
          defaultMessage: "Couldn't start the Discussion",
        }),
      );
      if (!result) {
        if (!semantic) removeCommentMark(current, discussionId);
        setActiveId((active) => (active === discussionId ? null : active));
      }
    },
    [pageId, run],
  );

  const start = useCallback(
    (kind: NfmDiscussionStartKind) => {
      const current = editorRef.current;
      if (!current) return;
      const { from, to } = current.prosemirrorState.selection;
      if (from >= to) return;
      const quote = current.prosemirrorState.doc.textBetween(from, to, " ").trim();
      const selectedIds = (current.getSelection()?.blocks ?? []).map((block) => block.id);
      const blockId = selectedIds[0] ?? current.getTextCursorPosition().block.id;
      const blockIds = selectedIds.length > 0 ? selectedIds : [blockId];
      if (kind === "check") {
        void createTextDiscussion({
          from,
          to,
          quote,
          blockId,
          blockIds,
          body: getIntl().formatMessage({
            id: "pageDiscussions.controller.checkQuestion",
            defaultMessage: "Is this true?",
          }),
          toNodex: true,
          askKind: "check",
        });
        return;
      }
      setNfmDiscussionMarksPresentation(current, {
        ...currentPresentation(current),
        draft: { from, to },
      });
      setDraft({ kind, quote, blockId, blockIds });
    },
    [createTextDiscussion],
  );

  const cancelDraft = useCallback(() => {
    setDraft(null);
    const current = editorRef.current;
    if (current)
      setNfmDiscussionMarksPresentation(current, { ...currentPresentation(current), draft: null });
  }, []);

  const submitDraft = useCallback(
    (submit: DiscussionComposerSubmit) => {
      const current = editorRef.current;
      if (!current || !draft) return;
      const range = draftRange(current);
      cancelDraft();
      if (!range) return;
      void createTextDiscussion({
        ...range,
        quote: draft.quote,
        blockId: draft.blockId,
        blockIds: draft.blockIds,
        body: submit.bodyMarkdown,
        toNodex: submit.toNodex,
        askKind: submit.toNodex ? "ask" : null,
      });
    },
    [cancelDraft, createTextDiscussion, draft],
  );

  const reply = useCallback(
    (discussionId: string, submit: DiscussionComposerSubmit) => {
      void run(
        {
          kind: "reply",
          discussionId,
          comment: {
            body: submit.bodyMarkdown,
            toNodex: submit.toNodex,
            ...(submit.toNodex ? { askKind: "ask" as const } : {}),
            ...(submit.toNodex && besideSessionRef.current
              ? { requestedSessionId: besideSessionRef.current }
              : {}),
          },
        },
        getIntl().formatMessage({
          id: "pageDiscussions.controller.replyFailed",
          defaultMessage: "Couldn't send the reply",
        }),
      );
    },
    [run],
  );

  const submitAsk = useCallback(
    async (submission: NfmPageAskSubmission) => {
      const current = editorRef.current;
      if (!current) return;
      const block = current.getBlock(submission.blockId);
      if (!block) return;
      const discussionId = createUuidV7();
      const props = { intent: submission.request.slice(0, 300), discussion: discussionId };
      const empty =
        block.type === "paragraph" &&
        (!Array.isArray(block.content) || block.content.length === 0) &&
        block.children.length === 0;
      let pendingBlockId = block.id;
      if (empty) {
        current.updateBlock(block.id, { type: "pending", props, content: undefined });
      } else {
        const [inserted] = current.insertBlocks([{ type: "pending", props }], block.id, "after");
        if (!inserted) return;
        pendingBlockId = inserted.id;
      }
      // The pending block itself shows the Ask's progress, so its card stays closed.
      const agent = pageAskAgentFromConfig(submission.agentConfig);
      try {
        await flushRef.current();
      } catch (error) {
        toastFailure(
          getIntl().formatMessage({
            id: "pageDiscussions.controller.askFailed",
            defaultMessage: "Couldn't ask Nodex",
          }),
          error,
        );
        current.removeBlocks([pendingBlockId]);
        return;
      }
      const result = await run(
        createInPlaceAskCommand({
          pageId,
          discussionId,
          pendingBlockId,
          request: submission.request,
          ...(agent ? { askAgent: agent } : {}),
          ...(besideSessionRef.current ? { requestedSessionId: besideSessionRef.current } : {}),
        }),
        getIntl().formatMessage({
          id: "pageDiscussions.controller.askFailed",
          defaultMessage: "Couldn't ask Nodex",
        }),
      );
      if (!result) current.removeBlocks([pendingBlockId]);
    },
    [pageId, run],
  );

  const execute = query.execute;
  const prepareSuggestedEdit = useCallback(
    (hunk: SuggestionHunk) => {
      const operationId = createUuidV7();
      const command: DiscussionCommand = {
        kind: "create",
        pageId,
        discussionId: operationId,
        anchor: { kind: "blocks", blockIds: [...hunk.blockIds] },
        firstComment: {
          body: getIntl().formatMessage({
            id: "pageDiscussions.controller.suggestedEditBody",
            defaultMessage: "Suggested edit",
          }),
          suggestedEdit: {
            blockIds: [...hunk.blockIds],
            expectedOldMarkdown: hunk.oldMarkdown,
            newMarkdown: hunk.newMarkdown,
          },
        },
      };
      return () => {
        // Reconnects can supply a newer Store identity for the same route.
        const current = executeRef.current;
        const send = current.route === commandRoute ? current.execute : execute;
        return send(command, operationId).then(
          () => true,
          (error: unknown) => {
            toastFailure(
              getIntl().formatMessage({
                id: "pageDiscussions.controller.suggestFailed",
                defaultMessage: "Couldn't suggest the edit",
              }),
              error,
            );
            return false;
          },
        );
      };
    },
    [commandRoute, execute, pageId],
  );
  const suggestionSession = useSuggestionSession({
    editor,
    suggesting,
    prepareSubmission: prepareSuggestedEdit,
  });
  const writeLocked = suggesting && suggestionSession.session === null;

  // Marked text reads as part of a Discussion only while that Discussion is open or focused.
  const visibleKey = views
    .filter((view) => !view.resolved || view.id === activeId)
    .map((view) => view.id)
    .join(",");
  const suggestedKey = views
    .flatMap((view) => view.comments)
    .flatMap((comment) =>
      comment.suggestedEdit?.state === "open" ? comment.suggestedEdit.blockIds : [],
    )
    .join(",");
  useEffect(() => {
    if (!editor) return;
    setNfmDiscussionMarksPresentation(editor, {
      visible: new Set(visibleKey ? visibleKey.split(",") : []),
      activeId,
      draft: currentPresentation(editor).draft,
      suggestedBlockIds: new Set(suggestedKey ? suggestedKey.split(",") : []),
      writeLocked,
    });
  }, [activeId, editor, suggestedKey, visibleKey, writeLocked]);

  // Another surface, such as the Inbox, may have opened this Page to show one Discussion.
  const viewIdsKey = views.map((view) => view.id).join(",");
  useEffect(() => {
    if (!editor) return;
    const reveal = () => {
      const ids = new Set(viewIdsKey.split(","));
      const discussionId = takeDiscussionReveal(pageId, (id) => ids.has(id));
      if (discussionId) revealDiscussionAnchor(editor, viewsRef.current, discussionId, setActiveId);
    };
    reveal();
    return subscribeDiscussionReveal(reveal);
  }, [editor, pageId, viewIdsKey]);

  useEffect(() => {
    const root = editor?.domElement;
    if (!root) return;
    const onActivate = (event: Event) => {
      const detail = (event as CustomEvent<NfmDiscussionActivateDetail>).detail;
      setActiveId(detail.discussionId);
    };
    root.addEventListener(NFM_DISCUSSION_ACTIVATE_EVENT, onActivate);
    return () => root.removeEventListener(NFM_DISCUSSION_ACTIVATE_EVENT, onActivate);
  }, [editor]);

  const actions = useMemo<DiscussionCardActions>(() => {
    const intl = getIntl();
    const failed = (id: string, defaultMessage: string) =>
      intl.formatMessage({ id, defaultMessage });
    const commentOf = (commentId: string) =>
      viewsRef.current.flatMap((view) => view.comments).find((comment) => comment.id === commentId);
    return {
      resolve: (discussionId) => {
        setActiveId((active) => (active === discussionId ? null : active));
        void run(
          { kind: "resolve", discussionId },
          failed("pageDiscussions.controller.resolveFailed", "Couldn't resolve the Discussion"),
        );
      },
      reopen: (discussionId) =>
        void run(
          { kind: "reopen", discussionId },
          failed("pageDiscussions.controller.reopenFailed", "Couldn't reopen the Discussion"),
        ),
      acceptSuggestedEdit: (commentId) =>
        void run(
          { kind: "accept", commentId },
          failed("pageDiscussions.controller.acceptFailed", "Couldn't accept the suggested edit"),
        ),
      rejectSuggestedEdit: (commentId) =>
        void run(
          { kind: "reject", commentId },
          failed("pageDiscussions.controller.rejectFailed", "Couldn't reject the suggested edit"),
        ),
      askNodex: (discussionId) =>
        reply(discussionId, {
          bodyMarkdown: intl.formatMessage({
            id: "pageDiscussions.controller.askNodexBody",
            defaultMessage: "Nodex, can you look into this?",
          }),
          toNodex: true,
        }),
      stopAsk: (commentId) =>
        void run(
          { kind: "stop_ask", commentId },
          failed("pageDiscussions.controller.stopFailed", "Couldn't stop Nodex"),
        ),
      retryAsk: (commentId) => {
        const state = commentOf(commentId)?.ask?.state;
        if (state !== "failed" && state !== "stopped") return;
        void run(
          { kind: "update_ask", commentId, expectedState: state, state: "queued" },
          failed("pageDiscussions.controller.retryFailed", "Couldn't retry the Ask"),
        );
      },
      openConversation: (sessionId) => void onOpenSession?.(sessionId),
      undoAsk: (discussionId) => {
        const runId = viewsRef.current.find((view) => view.id === discussionId)?.latestAsk?.runId;
        if (!runId) return;
        void run(
          { kind: "revert_run", pageId, runId },
          failed("pageDiscussions.controller.undoFailed", "Couldn't undo this Ask"),
        );
      },
    };
  }, [onOpenSession, pageId, reply, run]);

  const binding = useMemo<NfmPageDiscussionsBinding>(
    () => ({
      attachEditor: setEditor,
      start,
      // An in-place Ask writes a pending block, which suggesting never does.
      submitAsk: canEditPage && !suggesting ? (submission) => void submitAsk(submission) : null,
    }),
    [canEditPage, start, submitAsk, suggesting],
  );

  return {
    views,
    loading: query.loading,
    nowMs,
    editor,
    activeId,
    setActiveId,
    draft,
    cancelDraft,
    submitDraft,
    reply,
    actions,
    members,
    sendToNodex,
    setSendToNodex,
    nodexAnswersQuestions: query.nodexAnswersQuestions ?? false,
    setNodexAnswersQuestions: (next) =>
      void run(
        { kind: "set_page_setting", pageId, nodexAnswersQuestions: next },
        getIntl().formatMessage({
          id: "pageDiscussions.controller.settingFailed",
          defaultMessage: "Couldn't change who answers questions here",
        }),
      ),
    canEditPage,
    suggesting,
    setSuggestMode: (next) => {
      if (!next && !suggestionSession.discard()) return;
      setSuggestMode(next);
    },
    suggestion: suggestionSession.session,
    submitSuggestions: () => void suggestionSession.submit(),
    discardSuggestions: suggestionSession.discard,
    writerOf: (blockId) => writerMap.get(blockId) ?? null,
    memberName,
    createAnchoredDiscussion: ({ anchor, body, toNodex, askKind = "ask" }) => {
      const discussionId = createUuidV7();
      setActiveId(discussionId);
      void run(
        {
          kind: "create",
          pageId,
          discussionId,
          firstCommentId: createUuidV7(),
          anchor:
            anchor.kind === "page"
              ? { kind: "page" }
              : anchor.kind === "blocks"
                ? { kind: "blocks", blockIds: [...anchor.blockIds] }
                : {
                    kind: "datum",
                    blockId: anchor.blockId,
                    source: anchor.source,
                    key: anchor.key as never,
                    ...(anchor.field ? { field: anchor.field } : {}),
                  },
          firstComment: {
            body,
            toNodex,
            ...(toNodex ? { askKind } : {}),
            ...(toNodex && besideSessionId ? { requestedSessionId: besideSessionId } : {}),
          },
        },
        getIntl().formatMessage({
          id: "pageDiscussions.controller.createFailed",
          defaultMessage: "Couldn't start the Discussion",
        }),
      );
    },
    suggestVisualSource: (blockId, originalSource, source) => {
      const visualMarkdown = (content: string) =>
        writeMarkdown([{ type: "codeBlock", props: { language: "visual" }, content }]);
      void prepareSuggestedEdit({
        blockIds: [blockId],
        oldMarkdown: visualMarkdown(originalSource),
        newMarkdown: visualMarkdown(source),
      })();
    },
    binding,
  };
}

/** Opens a Discussion's card and scrolls its anchor into view. */
export function revealDiscussionAnchor(
  editor: NfmDiscussionsEditor | null,
  views: readonly DiscussionView[],
  discussionId: string,
  setActiveId: (discussionId: string) => void,
): void {
  setActiveId(discussionId);
  const view = views.find((candidate) => candidate.id === discussionId);
  const root = editor?.domElement;
  if (!view || !root) return;
  const blockId =
    view.anchor.kind === "blocks"
      ? view.anchor.blockIds[0]
      : view.anchor.kind === "datum"
        ? view.anchor.blockId
        : null;
  const target =
    view.anchor.kind === "text"
      ? root.querySelector(`[data-bn-thread-id="${escapeAttributeValue(discussionId)}"]`)
      : blockId
        ? findBlockElementById(root, blockId)
        : null;
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function currentPresentation(editor: NfmDiscussionsEditor) {
  return (
    nfmDiscussionMarksPluginKey.getState(editor.prosemirrorState)?.presentation ??
    EMPTY_DISCUSSION_MARKS_PRESENTATION
  );
}
