import type { SessionLinkedPageStore } from "@/lib/session-linked-page";

/** Sidebar interaction fixtures have no linked Page or live Desktop subscription. */
export const emptySessionLinkedPageStore: SessionLinkedPageStore = {
  read: () => null,
  subscribeSession: () => () => {},
};
