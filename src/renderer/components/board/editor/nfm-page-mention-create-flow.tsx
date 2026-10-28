import { SuggestionMenu, type SuggestionDeferredAcceptance } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useExtensionState } from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { NfmSideMenuPageInIcon, PageIcon } from "@/components/shared/icons";
import { useBlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import { NodexDropdownSurface } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { blockNoteInlineToPortableRichText } from "../../../../shared/block-documents/blocknote-rich-text";
import type { PortableRichText } from "../../../../shared/block-documents/portable-rich-text";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { NfmMoveToMenu } from "./nfm-move-to-menu";
import type { NfmMoveToDestination } from "./nfm-move-to-menu-model";
import type { NfmSuggestionItem } from "./nfm-suggestion-item";

interface NfmPageMentionCreateLease {
  readonly lease: SuggestionDeferredAcceptance;
  readonly pageId: string;
  readonly title: string;
  readonly expectedContent: PortableRichText;
  readonly replacementContent: PortableRichText;
}

function NfmPageMentionDestinationMenu({
  activeProjectId,
  sourcePageId,
  flow,
  onAccept,
  onAbandon,
}: {
  readonly activeProjectId: string | null;
  readonly sourcePageId: string | null;
  readonly flow: NfmPageMentionCreateLease;
  readonly onAccept: (
    flow: NfmPageMentionCreateLease,
    destination: NfmMoveToDestination,
  ) => Promise<void>;
  readonly onAbandon: (flow: NfmPageMentionCreateLease) => void;
}) {
  return (
    <NodexDropdownSurface className="w-[min(20.625rem,calc(100vw-16px))] overflow-hidden p-0">
      <NfmMoveToMenu
        sourceProjectId={activeProjectId}
        sourcePageId={sourcePageId}
        resultScope="page-only"
        ariaLabel="Create page in"
        placeholder="Create page in…"
        autoFocus
        onAccept={(destination) => onAccept(flow, destination)}
        onClose={() => onAbandon(flow)}
      />
    </NodexDropdownSurface>
  );
}

export function buildNfmPageMentionCreateSuggestionItems(input: {
  readonly query: string;
  readonly canCreate: boolean;
  readonly onCreateInCurrentPage: () => void;
  readonly onChooseDestination: () => void;
}): NfmSuggestionItem[] {
  if (!input.canCreate) return [];
  const title = input.query.trim();
  return [
    {
      key: "create-page-mention-current",
      title: title ? `New “${title}” sub-page` : "Add new sub-page",
      subtext: "Create in this Page",
      aliases: [],
      hint: "Enter",
      mentionCreate: { kind: "current_page" },
      icon: <PageIcon className="size-4" aria-hidden="true" />,
      onItemClick: input.onCreateInCurrentPage,
    },
    {
      key: "create-page-mention-destination",
      title: title ? `New “${title}” page in…` : "Add new page in…",
      subtext: "Choose a parent Page",
      aliases: [],
      hint: null,
      mentionCreate: { kind: "choose_destination" },
      icon: <NfmSideMenuPageInIcon className="size-4" aria-hidden="true" />,
      onItemClick: input.onChooseDestination,
    },
  ];
}

/** Owns the authoritative async transition shared by `@`, `+`, and `[[`. */
export function useNfmPageMentionCreateFlow({
  activeProjectId,
}: {
  readonly activeProjectId: string | null;
}): {
  readonly canCreate: boolean;
  readonly buildCreateItems: (query: string) => NfmSuggestionItem[];
  readonly destinationMenu: ReactNode | null;
} {
  const editor = useBlockNoteEditor();
  const hostRuntime = useBlockReferenceHostRuntime();
  const hostRuntimeRef = useRef(hostRuntime);
  hostRuntimeRef.current = hostRuntime;
  const [destinationFlow, setDestinationFlow] = useState<NfmPageMentionCreateLease | null>(null);
  const pendingSuggestionSessionId = useExtensionState(SuggestionMenu, {
    selector: (state) =>
      state?.show && state.acceptancePhase === "pending_authoritative" ? state.sessionId : null,
  });
  const clearDestinationFlow = useCallback((flow: NfmPageMentionCreateLease) => {
    setDestinationFlow((current) => (current?.lease === flow.lease ? null : current));
  }, []);

  // A destination flow is a child state of one exact suggestion session. Pointer,
  // selection, and controller-driven closes can invalidate that parent without
  // invoking the picker's explicit close callback, so discard the orphan here.
  useEffect(() => {
    if (!destinationFlow) return;
    if (pendingSuggestionSessionId === destinationFlow.lease.sessionId) return;
    destinationFlow.lease.rollback("parent-suggestion-ended");
    clearDestinationFlow(destinationFlow);
  }, [clearDestinationFlow, destinationFlow, pendingSuggestionSessionId]);

  const beginCreateFlow = useCallback(
    (query: string): NfmPageMentionCreateLease | null => {
      if (!hostRuntimeRef.current?.createPageMention) return null;
      const pageId = createUuidV7();
      const replacement = [{ type: "pageMention", props: { targetPageId: pageId } }, " "] as const;
      const lease = editor.getExtension(SuggestionMenu)?.beginDeferredAcceptance(replacement);
      if (!lease) return null;

      try {
        return {
          lease,
          pageId,
          title: query.trim() || "Untitled",
          expectedContent: blockNoteInlineToPortableRichText(lease.expectedContent),
          replacementContent: blockNoteInlineToPortableRichText(lease.replacementContent),
        };
      } catch (error) {
        lease.rollback("unsupported-inline-content");
        toast.danger(error instanceof Error ? error.message : "This Block cannot create a Page.");
        return null;
      }
    },
    [editor],
  );
  const abandonCreateFlow = useCallback(
    (flow: NfmPageMentionCreateLease) => {
      // A pending suggestion lease may hand focus to its nested picker. Return
      // focus while the lease still guards the parent session, then resume it.
      editor.focus();
      flow.lease.rollback("create-page-abandoned");
      clearDestinationFlow(flow);
    },
    [clearDestinationFlow, editor],
  );
  const finishCreateFlow = useCallback(
    async (flow: NfmPageMentionCreateLease, destinationPageId?: string) => {
      const createPageMention = hostRuntimeRef.current?.createPageMention;
      if (!createPageMention) {
        abandonCreateFlow(flow);
        toast.danger("Page creation is unavailable here.");
        return;
      }

      try {
        await createPageMention({
          pageId: flow.pageId,
          title: flow.title,
          blockId: flow.lease.blockId,
          expectedContent: flow.expectedContent,
          replacementContent: flow.replacementContent,
          ...(destinationPageId ? { destinationPageId } : {}),
        });
        if (!flow.lease.commit()) {
          throw new Error("The created Page mention did not reach this editor.");
        }
        clearDestinationFlow(flow);
      } catch (error) {
        editor.focus();
        flow.lease.rollback("create-page-failed");
        clearDestinationFlow(flow);
        toast.danger(error instanceof Error ? error.message : "Couldn’t create this Page.");
      }
    },
    [abandonCreateFlow, clearDestinationFlow, editor],
  );
  const buildCreateItems = useCallback(
    (query: string) =>
      buildNfmPageMentionCreateSuggestionItems({
        query,
        canCreate: Boolean(hostRuntimeRef.current?.createPageMention),
        onCreateInCurrentPage: () => {
          const flow = beginCreateFlow(query);
          if (flow) void finishCreateFlow(flow);
        },
        onChooseDestination: () => {
          const flow = beginCreateFlow(query);
          if (flow) setDestinationFlow(flow);
        },
      }),
    [beginCreateFlow, finishCreateFlow],
  );
  const destinationMenu = useMemo(() => {
    if (!destinationFlow) return null;
    if (pendingSuggestionSessionId !== destinationFlow.lease.sessionId) return null;
    return (
      <NfmPageMentionDestinationMenu
        activeProjectId={activeProjectId}
        sourcePageId={hostRuntime?.hostPageId ?? null}
        flow={destinationFlow}
        onAccept={async (flow, destination) => {
          if (destination.kind !== "page") {
            throw new Error("Choose a Page for the new Page.");
          }
          await finishCreateFlow(flow, destination.pageId);
        }}
        onAbandon={abandonCreateFlow}
      />
    );
  }, [
    abandonCreateFlow,
    activeProjectId,
    destinationFlow,
    finishCreateFlow,
    hostRuntime?.hostPageId,
    pendingSuggestionSessionId,
  ]);

  return {
    canCreate: Boolean(hostRuntime?.createPageMention),
    buildCreateItems,
    destinationMenu,
  };
}
