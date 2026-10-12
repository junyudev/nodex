import { clearContentSearchMarks } from "../../content-search/content-search-dom";
import type {
  ContentSearchLocalMatch,
  ContentSearchLocalResult,
} from "../../content-search/content-search-model";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";
import { applyLocalConversationSearchHighlights } from "./local-conversation-thread-search-dom-marks";

export const LOCAL_CONVERSATION_SEARCH_HIGHLIGHT_DELAY_MS = 80;

/** One retained result owns typed-unit marks until its query/source is retired. */
export function createLocalConversationSearchHighlightOwner(input: {
  readonly readRoot: () => HTMLElement | null;
  readonly resolveTarget: (match: ContentSearchLocalMatch) => LocalConversationSearchTarget | null;
}) {
  let current: { result: ContentSearchLocalResult; activeMatchId: string } | null = null;
  let root: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: HTMLElement | null = null;
  let generation = 0;

  const cancelScheduled = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const disconnect = () => {
    cancelScheduled();
    observer?.disconnect();
    observer = null;
    if (root) clearContentSearchMarks(root);
    root = null;
    active = null;
  };
  const refresh = () => {
    if (!current) return;
    const nextRoot = input.readRoot();
    if (nextRoot !== root) {
      disconnect();
      root = nextRoot;
      if (root) {
        const observedRoot = root;
        const observedGeneration = generation;
        observer = new MutationObserver(() => {
          if (observedGeneration !== generation || observedRoot !== root || !current) return;
          if (timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            if (observedGeneration === generation && observedRoot === root) refresh();
          }, LOCAL_CONVERSATION_SEARCH_HIGHLIGHT_DELAY_MS);
        });
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributeFilter: ["hidden"],
        });
      }
    }
    if (!root) return;
    cancelScheduled();
    const retainedMatches = current.result.matches.flatMap((match) => {
      const target = input.resolveTarget(match);
      return target ? [{ id: match.id, target }] : [];
    });
    active = applyLocalConversationSearchHighlights({
      root,
      query: current.result.query,
      target: null,
      retainedMatches,
      activeMatchId: current.activeMatchId,
    });
    // Drain our synchronous DOM writes, not mark/text-shaped records from React replacements.
    observer?.takeRecords();
  };
  return {
    publishResult(result: ContentSearchLocalResult, activeMatchId: string) {
      current = { result, activeMatchId };
      refresh();
    },
    refresh,
    readActiveMatch(matchId: string): HTMLElement | null {
      if (
        current?.activeMatchId !== matchId ||
        !active?.isConnected ||
        !root?.contains(active) ||
        active.closest("[hidden]")
      )
        return null;
      return active;
    },
    clear() {
      generation += 1;
      current = null;
      disconnect();
    },
  };
}
