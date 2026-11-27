import { PositionPopover } from "@blocknote/react";
import { useEffect, useRef } from "react";
import { useIntl } from "@/lib/i18n";
import { NodexFloatingLayerProvider } from "@/components/ui/floating-layer";
import {
  createNfmEditorFloatingMiddleware,
  NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT,
  NFM_EDITOR_FLOATING_UI_Z_INDEX,
} from "@/components/board/editor/nfm-blocknote-floating-ui";
import { nfmDiscussionMarksPluginKey } from "@/components/board/editor/nfm-discussion-marks-extension";
import type { PageDiscussionsController } from "../use-page-discussions-controller";
import { usePageDiscussionsControllerContext } from "../page-discussions-context";
import { DiscussionComposer } from "./discussion-composer";

const FLOATING_OPTIONS = {
  useFloatingOptions: {
    open: true,
    placement: "bottom-start" as const,
    strategy: "fixed" as const,
    middleware: createNfmEditorFloatingMiddleware(6),
  },
  focusManagerProps: { disabled: true },
  elementProps: { style: { zIndex: NFM_EDITOR_FLOATING_UI_Z_INDEX } },
};

/**
 * The first Comment of a new Discussion, floating under the selection it is about. The selection
 * stays highlighted while the person writes; Escape or pointing elsewhere drops the draft.
 */
export function NewDiscussionComposer() {
  const controller = usePageDiscussionsControllerContext();
  return controller ? <NewDiscussionComposerPanel controller={controller} /> : null;
}

function NewDiscussionComposerPanel({
  controller,
}: {
  readonly controller: PageDiscussionsController;
}) {
  const intl = useIntl();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { draft, editor, cancelDraft } = controller;

  useEffect(() => {
    if (!draft) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      cancelDraft();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [cancelDraft, draft]);

  if (!draft || !editor) return null;
  const range = nfmDiscussionMarksPluginKey.getState(editor.prosemirrorState)?.presentation.draft;
  if (!range) return null;
  const asking = draft.kind === "ask";
  return (
    <PositionPopover
      position={{ from: range.from, to: range.to }}
      portalElement={NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT}
      {...FLOATING_OPTIONS}
    >
      <NodexFloatingLayerProvider zIndex={NFM_EDITOR_FLOATING_UI_Z_INDEX}>
        <div
          ref={panelRef}
          role="dialog"
          aria-label={intl.formatMessage(
            asking
              ? {
                  id: "pageDiscussions.newDiscussion.askLabel",
                  defaultMessage: "Ask Nodex about the selection",
                }
              : {
                  id: "pageDiscussions.newDiscussion.commentLabel",
                  defaultMessage: "Comment on the selection",
                },
          )}
          className="pointer-events-auto w-[min(22rem,calc(100vw-24px))] rounded-xl bg-token-dropdown-background p-1.5 text-sm shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
        >
          <DiscussionComposer
            autoFocus
            placeholder={intl.formatMessage(
              asking
                ? {
                    id: "pageDiscussions.newDiscussion.askPlaceholder",
                    defaultMessage: "Ask Nodex about this…",
                  }
                : {
                    id: "pageDiscussions.newDiscussion.commentPlaceholder",
                    defaultMessage: "Comment, or @mention someone…",
                  },
            )}
            members={controller.members}
            sendToNodex={asking || controller.sendToNodex}
            onSendToNodexChange={asking ? () => {} : controller.setSendToNodex}
            onSubmit={controller.submitDraft}
            onCancel={() => {
              cancelDraft();
              editor.focus();
            }}
          />
        </div>
      </NodexFloatingLayerProvider>
    </PositionPopover>
  );
}
