import type { InboxScope } from "@nodex/mobile-protocol";

import type { LocalImage } from "../../runtime";
import { createLocalStore } from "../../ui/local-store";

export type HomeMode = "inbox" | "chats";

export interface ComposerDraft {
  readonly text: string;
  readonly images: readonly LocalImage[];
}

const EMPTY_DRAFT: ComposerDraft = { text: "", images: [] };

/** The Turn the Inbox Composer answers instead of capturing a new thought. */
export interface ReplyTarget {
  readonly spaceKey?: string | null;
  readonly entryId: string;
  readonly episode: string;
  readonly title: string;
}

interface HomeState {
  readonly mode: HomeMode;
  readonly scope: InboxScope;
  readonly filter: "inbox" | "processed";
  /** Keyed by (Space, Member, Composer): `inbox`, `new-chat`, or a chat's Session. */
  readonly drafts: Readonly<Record<string, ComposerDraft>>;
  /** How many captures this phone has sent, so the stream can return to its end for each. */
  readonly capturesSent: number;
  readonly replyTo: ReplyTarget | null;
  readonly setReplyTo: (target: ReplyTarget | null) => void;
  /** The chat search, while it is open. */
  readonly search: string | null;
  /** Whether the Chats list shows archived chats instead of the rest. */
  readonly chatsArchived: boolean;
  readonly noteCaptureSent: () => void;
  readonly setMode: (mode: HomeMode) => void;
  readonly setScope: (scope: InboxScope) => void;
  readonly toggleFilter: () => void;
  readonly setSearch: (search: string | null) => void;
  readonly setChatsArchived: (archived: boolean) => void;
  readonly setDraft: (key: string, patch: Partial<ComposerDraft>) => void;
  readonly clearDraft: (key: string) => void;
  readonly forgetSpace: (spaceKey: string) => void;
}

/** What the person was doing on this phone; none of it is a Host's state. */
export const useHomeState = createLocalStore<HomeState>({
  mode: "inbox",
  scope: { kind: "all" },
  filter: "inbox",
  drafts: {},
  capturesSent: 0,
  replyTo: null,
  setReplyTo: (replyTo) => useHomeState.setState({ replyTo }),
  search: null,
  chatsArchived: false,
  noteCaptureSent: () =>
    useHomeState.setState(({ capturesSent }) => ({ capturesSent: capturesSent + 1 })),
  setMode: (mode) => useHomeState.setState({ mode }),
  setScope: (scope) => useHomeState.setState({ scope, filter: "inbox", replyTo: null }),
  toggleFilter: () =>
    useHomeState.setState(({ filter }) => ({
      filter: filter === "inbox" ? "processed" : "inbox",
    })),
  setSearch: (search) => useHomeState.setState({ search }),
  setChatsArchived: (chatsArchived) => useHomeState.setState({ chatsArchived }),
  setDraft: (key, patch) =>
    useHomeState.setState(({ drafts }) => ({
      drafts: { ...drafts, [key]: { ...(drafts[key] ?? EMPTY_DRAFT), ...patch } },
    })),
  forgetSpace: (spaceKey) =>
    useHomeState.setState(({ drafts, replyTo }) => ({
      drafts: Object.fromEntries(
        Object.entries(drafts).filter(([key]) => {
          try {
            return JSON.parse(key)[0] !== spaceKey;
          } catch {
            return true;
          }
        }),
      ),
      replyTo: replyTo?.spaceKey === spaceKey ? null : replyTo,
    })),
  clearDraft: (key) =>
    useHomeState.setState(({ drafts }) => {
      const { [key]: _removed, ...rest } = drafts;
      return { drafts: rest };
    }),
});

export const useDraft = (key: string): ComposerDraft =>
  useHomeState((state) => state.drafts[key] ?? EMPTY_DRAFT);
