import type { LinkActivation } from "./link-opening";
import { parsePageDeepLink, parseSessionDeepLink, parseViewDeepLink } from "./nodex-deeplink";

/**
 * A Nodex object a person can open from a reference: a Page (optionally one of its Blocks), a
 * Database View, or a chat's Session. `spaceId` is present only when the link names its Space.
 */
export type NodexDestination =
  | {
      readonly kind: "page";
      readonly pageId: string;
      readonly blockId?: string;
      readonly spaceId?: string;
    }
  | { readonly kind: "view"; readonly viewId: string; readonly spaceId?: string }
  | { readonly kind: "session"; readonly sessionId: string; readonly spaceId?: string };

/** Reads `nodex://pages|views|sessions/ID` links, the one spelling every surface writes. */
export function parseNodexDestination(href: string | null | undefined): NodexDestination | null {
  if (typeof href !== "string") return null;
  const page = parsePageDeepLink(href);
  if (page) return { kind: "page", ...page };
  const session = parseSessionDeepLink(href);
  if (session) return { kind: "session", ...session };
  const view = parseViewDeepLink(href);
  if (view) return { kind: "view", ...view };
  return null;
}

/** Where a reference is read; it decides what a plain activation means. */
export type NodexReferenceSurface = "conversation" | "page" | "inbox" | "workbench";

/** What the person did to a reference. */
export type NodexReferenceGesture =
  | { readonly kind: "activate"; readonly activation?: LinkActivation }
  /** Double-click keeps what a plain activation would have previewed. */
  | { readonly kind: "keep" }
  | { readonly kind: "menu"; readonly action: "open" | "new-tab" | "new-window" };

/** Where Page and View content opens relative to the reference that opened it. */
export type NodexContentPlacement =
  /** Beside the reading surface: a chat's content panel, or the group to an Inbox's right. */
  | "beside"
  /** In the reading surface's own tab group, as a Page opens the Pages it links to. */
  | "source-group"
  /** The content's own Scene: its Project, or Space. */
  | "home";

export type NodexReferenceOpen =
  | {
      readonly kind: "content";
      readonly placement: NodexContentPlacement;
      readonly mode: "preview" | "durable";
      /** A background open adds the tab without selecting it. */
      readonly activate: boolean;
    }
  /** Go to the chat; the Workbench decides whether it is a side chat, a Dock target or a Scene. */
  | { readonly kind: "session" }
  | { readonly kind: "new-window" };

type GestureIntent = "default" | "keep" | "background-tab" | "foreground-tab" | "home" | "window";

function readGestureIntent(gesture: NodexReferenceGesture): GestureIntent {
  if (gesture.kind === "keep") return "keep";
  if (gesture.kind === "menu")
    return gesture.action === "new-tab"
      ? "foreground-tab"
      : gesture.action === "new-window"
        ? "window"
        : "default";
  const activation = gesture.activation;
  if (!activation) return "default";
  const primary = activation.platform === "darwin" ? activation.metaKey : activation.ctrlKey;
  if (activation.button === 1) return activation.shiftKey ? "foreground-tab" : "background-tab";
  if (activation.button != null && activation.button !== 0) return "default";
  if (primary && activation.altKey) return "home";
  if (primary) return activation.shiftKey ? "foreground-tab" : "background-tab";
  return "default";
}

const DEFAULT_PLACEMENT: Record<NodexReferenceSurface, NodexContentPlacement> = {
  conversation: "beside",
  inbox: "beside",
  page: "source-group",
  workbench: "home",
};

/**
 * One gesture grammar for every Nodex reference, shared with web links: Primary or middle opens
 * additionally without replacing what is shown, Shift brings that tab forward, Primary+Alt goes to
 * the content's own Scene. A chat is a Scene and never a tab, so opening one additionally uses a
 * new window. Plain activation follows the reading surface: a chat previews content beside itself.
 */
export function decideNodexReferenceOpen(input: {
  readonly destination: Pick<NodexDestination, "kind">;
  readonly surface: NodexReferenceSurface;
  readonly gesture: NodexReferenceGesture;
}): NodexReferenceOpen {
  const intent = readGestureIntent(input.gesture);
  if (input.destination.kind === "session")
    return intent === "background-tab" || intent === "foreground-tab" || intent === "window"
      ? { kind: "new-window" }
      : { kind: "session" };
  if (intent === "window") return { kind: "new-window" };
  if (intent === "home")
    return { kind: "content", placement: "home", mode: "durable", activate: true };
  const placement = DEFAULT_PLACEMENT[input.surface];
  if (intent === "background-tab")
    return { kind: "content", placement, mode: "durable", activate: false };
  if (intent === "foreground-tab" || intent === "keep")
    return { kind: "content", placement, mode: "durable", activate: true };
  return {
    kind: "content",
    placement,
    mode: input.surface === "conversation" || input.surface === "inbox" ? "preview" : "durable",
    activate: true,
  };
}
