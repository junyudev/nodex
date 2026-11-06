import type { InboxScope } from "@nodex/mobile-protocol";

import type { LocalImage } from "../../runtime";
import { createLocalStore } from "../../ui/local-store";

export type HomeMode = "inbox" | "chats";

export interface ComposerDraft {
  readonly text: string;
  readonly images: readonly LocalImage[];
}

const EMPTY_DRAFT: ComposerDraft = { text: "", images: [] };

interface HomeState {
  readonly mode: HomeMode;
  readonly scope: InboxScope;
  readonly filter: "inbox" | "processed";
  /** Keyed by Composer: `inbox`, `new-chat`, or a chat's Session. */
  readonly drafts: Readonly<Record<string, ComposerDraft>>;
  /** How many captures this phone has sent, so the stream can return to its end for each. */
  readonly capturesSent: number;
  /** The chat search, while it is open. */
  readonly search: string | null;
  readonly noteCaptureSent: () => void;
  readonly setMode: (mode: HomeMode) => void;
  readonly setScope: (scope: InboxScope) => void;
  readonly toggleFilter: () => void;
  readonly setSearch: (search: string | null) => void;
  readonly setDraft: (key: string, patch: Partial<ComposerDraft>) => void;
  readonly clearDraft: (key: string) => void;
}

/** What the person was doing on this phone; none of it is a Host's state. */
export const useHomeState = createLocalStore<HomeState>({
  mode: "inbox",
  scope: { kind: "library" },
  filter: "inbox",
  drafts: {},
  capturesSent: 0,
  search: null,
  noteCaptureSent: () =>
    useHomeState.setState(({ capturesSent }) => ({ capturesSent: capturesSent + 1 })),
  setMode: (mode) => useHomeState.setState({ mode }),
  setScope: (scope) => useHomeState.setState({ scope, filter: "inbox" }),
  toggleFilter: () =>
    useHomeState.setState(({ filter }) => ({
      filter: filter === "inbox" ? "processed" : "inbox",
    })),
  setSearch: (search) => useHomeState.setState({ search }),
  setDraft: (key, patch) =>
    useHomeState.setState(({ drafts }) => ({
      drafts: { ...drafts, [key]: { ...(drafts[key] ?? EMPTY_DRAFT), ...patch } },
    })),
  clearDraft: (key) =>
    useHomeState.setState(({ drafts }) => {
      const { [key]: _removed, ...rest } = drafts;
      return { drafts: rest };
    }),
});

export const useDraft = (key: string): ComposerDraft =>
  useHomeState((state) => state.drafts[key] ?? EMPTY_DRAFT);
