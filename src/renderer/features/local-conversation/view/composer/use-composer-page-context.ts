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

const exclusionsAtom = scopedAtom<readonly string[]>(ComposerScope, [], {
  debugLabel: "composer-page-context-exclusions",
});
const sessionIdAtom = scopedDerivedAtom(
  ThreadScope,
  (get) => get.scope(ThreadScope).projectSessionId,
  { debugLabel: "composer-page-context-session" },
);

/** Exclusion is authored draft intent; titles, visibility and selections remain live projections. */
export function useComposerPageContext(
  input: { readonly sessionId?: string | null; readonly composerScope?: ScopeHandle } = {},
) {
  const defaultScope = useScopeHandle(ComposerScope);
  const scope = input.composerScope ?? defaultScope;
  const scopedSessionId = useScopedAtomValue(sessionIdAtom);
  const sessionId = input.sessionId ?? scopedSessionId;
  const owner = getWorkbenchWindowOwner(useScopeHandle(appScope));
  const presentation = useSyncExternalStore(owner.subscribe, owner.read, owner.read);
  const subscribeExclusions = (listener: () => void) => scope.sub(exclusionsAtom, listener);
  const readExclusions = () => scope.get(exclusionsAtom);
  const exclusions = useSyncExternalStore(subscribeExclusions, readExclusions, readExclusions);
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
  const references: readonly PageReference[] = pages.flatMap((page, index) =>
    exclusions.includes(page.pageId)
      ? []
      : [
          {
            pageId: page.pageId,
            titleSnapshot: titles.titles[index] ?? page.titleSnapshot,
            selectedBlockIds: [
              ...new Set(page.editorKeys.flatMap((key) => editorSelections.get(key) ?? [])),
            ],
          },
        ],
  );
  /** Call synchronously at submit, before preparation can yield to another editor update. */
  const readSnapshot = (): readonly PageReference[] => {
    const excluded = scope.get(exclusionsAtom);
    return readPages().flatMap((page) =>
      excluded.includes(page.pageId)
        ? []
        : [
            {
              pageId: page.pageId,
              titleSnapshot: titles.readTitle(page.pageId, page.titleSnapshot),
              selectedBlockIds: [...new Set(page.editorKeys.flatMap(readPageEditorSelection))],
            },
          ],
    );
  };
  return {
    references,
    remove(pageId: string) {
      scope.set(exclusionsAtom, (current) =>
        current.includes(pageId) ? current : [...current, pageId],
      );
    },
    readSnapshot,
    async submit(
      deliver: (references: readonly PageReference[]) => Promise<boolean>,
    ): Promise<boolean> {
      const snapshot = readSnapshot();
      const sent = await deliver(snapshot);
      if (sent) scope.set(exclusionsAtom, []);
      return sent;
    },
  };
}
