import { useSyncExternalStore } from "react";
import {
  appScope,
  scopedAtom,
  scopedDerivedAtom,
  useScopeHandle,
  useScopedAtomValue,
  type ScopeHandle,
} from "@/lib/maitai";
import { ComposerScope, ThreadScope } from "@/lib/workbench-ui-scopes";
import { getWorkbenchWindowOwner } from "@/lib/workbench-window-owner";
import { readWorkbenchAgentContext } from "@/lib/workbench-agent-context";
import { selectComposerBesidePages } from "@/lib/composer-page-context";
import { usePresentedPageTitles } from "@/lib/page-title-projection-context";
import { usePageEditorSelections } from "@/lib/use-page-editor-selection";
import { readPageEditorSelection } from "@/lib/page-editor-observation-registry";
import type { PageReference } from "../../../../../shared/page-reference";

const inclusionsAtom = scopedAtom<readonly string[]>(ComposerScope, [], {
  debugLabel: "composer-page-context-inclusions",
});
const sessionIdAtom = scopedDerivedAtom(
  ThreadScope,
  (get) => get.scope(ThreadScope).projectSessionId,
  { debugLabel: "composer-page-context-session" },
);

/** A Page beside the chat, offered as message context and sent only once the user includes it. */
export interface ComposerPageContextOffer {
  readonly reference: PageReference;
  readonly included: boolean;
}

/** Inclusion is authored draft intent; titles, visibility and selections remain live projections. */
export function useComposerPageContext(
  input: { readonly sessionId?: string | null; readonly composerScope?: ScopeHandle } = {},
) {
  const defaultScope = useScopeHandle(ComposerScope);
  const scope = input.composerScope ?? defaultScope;
  const scopedSessionId = useScopedAtomValue(sessionIdAtom);
  const sessionId = input.sessionId ?? scopedSessionId;
  const owner = getWorkbenchWindowOwner(useScopeHandle(appScope));
  const presentation = useSyncExternalStore(owner.subscribe, owner.read, owner.read);
  const subscribeInclusions = (listener: () => void) => scope.sub(inclusionsAtom, listener);
  const readInclusions = () => scope.get(inclusionsAtom);
  const inclusions = useSyncExternalStore(subscribeInclusions, readInclusions, readInclusions);
  const readPages = () =>
    selectComposerBesidePages(
      sessionId ? readWorkbenchAgentContext(owner.read(), { kind: "session", sessionId }) : null,
    );
  const pages = selectComposerBesidePages(
    sessionId ? readWorkbenchAgentContext(presentation, { kind: "session", sessionId }) : null,
  );
  const titles = usePresentedPageTitles(pages);
  const selections = usePageEditorSelections(pages.flatMap((page) => page.editorKeys));
  const editorSelections = new Map(
    pages.flatMap((page) => page.editorKeys).map((key, index) => [key, selections[index] ?? []]),
  );
  const offers: readonly ComposerPageContextOffer[] = pages.map((page, index) => ({
    reference: {
      pageId: page.pageId,
      titleSnapshot: titles.titles[index] ?? page.titleSnapshot,
      selectedBlockIds: [
        ...new Set(page.editorKeys.flatMap((key) => editorSelections.get(key) ?? [])),
      ],
    },
    included: inclusions.includes(page.pageId),
  }));
  /** Call synchronously at submit, before preparation can yield to another editor update. */
  const readSnapshot = (): readonly PageReference[] => {
    const included = scope.get(inclusionsAtom);
    return readPages().flatMap((page) =>
      included.includes(page.pageId)
        ? [
            {
              pageId: page.pageId,
              titleSnapshot: titles.readTitle(page.pageId, page.titleSnapshot),
              selectedBlockIds: [...new Set(page.editorKeys.flatMap(readPageEditorSelection))],
            },
          ]
        : [],
    );
  };
  return {
    offers,
    include(pageId: string) {
      scope.set(inclusionsAtom, (current) =>
        current.includes(pageId) ? current : [...current, pageId],
      );
    },
    remove(pageId: string) {
      scope.set(inclusionsAtom, (current) => current.filter((id) => id !== pageId));
    },
    readSnapshot,
    async submit(
      deliver: (references: readonly PageReference[]) => Promise<boolean>,
    ): Promise<boolean> {
      const snapshot = readSnapshot();
      const sent = await deliver(snapshot);
      if (sent) scope.set(inclusionsAtom, []);
      return sent;
    },
  };
}
