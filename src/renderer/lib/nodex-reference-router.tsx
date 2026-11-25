import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  decideNodexReferenceOpen,
  type NodexContentPlacement,
  type NodexDestination,
  type NodexReferenceGesture,
  type NodexReferenceSurface,
} from "../../shared/nodex-reference";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { buildPageDeepLink, buildSessionDeepLink, buildViewDeepLink } from "./page-deeplink";
import { rendererSpaceId } from "./renderer-space";

/** Where a reference is read: the surface kind, and what placement beside it needs. */
export interface NodexReferenceSource {
  readonly surface: NodexReferenceSurface;
  /** The chat a conversation reference is read in. */
  readonly sessionId?: string | null;
  /** The Scene surface showing the reference, for opening beside it or in its group. */
  readonly surfaceId?: string;
  /** The Scene that shows the reference; the selected Scene when omitted. */
  readonly owner?: WorkbenchSceneOwner;
  /**
   * A surface that navigates its own content, as a Page editor follows its links within its tab
   * group, opens content in place itself.
   */
  readonly openInPlace?: (
    destination: NodexContentDestination,
    titleSnapshot?: string,
  ) => void | Promise<unknown>;
}

export type NodexContentDestination = Extract<NodexDestination, { kind: "page" | "view" }>;

/** The Workbench owners a reference opens through. */
export interface NodexReferenceRouterPort {
  readonly presentContent: (input: {
    readonly destination: NodexContentDestination;
    readonly source: NodexReferenceSource;
    readonly placement: NodexContentPlacement;
    readonly mode: "preview" | "durable";
    readonly activate: boolean;
    readonly titleSnapshot?: string;
    /** The Project an incoming link resolved to, whose Scene is the content's home. */
    readonly homeProjectId?: string | null;
    readonly isCurrent?: () => boolean;
  }) => Promise<boolean>;
  /** Goes to a chat: its side chat tab, the Project Agent Dock, or its own Scene. */
  readonly openSession: (input: {
    readonly sessionId: string;
    readonly source: NodexReferenceSource;
    readonly isCurrent?: () => boolean;
  }) => Promise<boolean>;
  readonly openInNewWindow: (
    destination: NodexDestination,
    titleSnapshot?: string,
  ) => Promise<boolean>;
  /** A link naming another Space opens in a window of that Space. */
  readonly openInSpace: (href: string) => Promise<boolean>;
}

export type NodexReferenceOpenOutcome = "opened" | "current" | "failed";

export interface NodexReferenceOpenInput {
  readonly source: NodexReferenceSource;
  readonly gesture: NodexReferenceGesture;
  readonly titleSnapshot?: string;
  /** A link arriving from outside names the Project it belongs to, when it has one. */
  readonly homeProjectId?: string | null;
  readonly isCurrent?: () => boolean;
}

export interface NodexReferenceRouter {
  readonly open: (
    destination: NodexDestination,
    input: NodexReferenceOpenInput,
  ) => Promise<NodexReferenceOpenOutcome>;
}

/** The canonical link for a destination, qualified only when it names another Space. */
export function buildNodexDestinationLink(destination: NodexDestination): string {
  if (destination.kind === "page") return buildPageDeepLink(destination);
  if (destination.kind === "view") return buildViewDeepLink(destination);
  return buildSessionDeepLink(destination);
}

export function isOtherSpaceDestination(destination: NodexDestination): boolean {
  return destination.spaceId !== undefined && destination.spaceId !== rendererSpaceId();
}

/** One decision for every reference, executed through the Workbench owners in `port`. */
export function createNodexReferenceRouter(port: NodexReferenceRouterPort): NodexReferenceRouter {
  return {
    open: async (destination, input) => {
      try {
        return await openDestination(port, destination, input);
      } catch {
        return "failed";
      }
    },
  };
}

async function openDestination(
  port: NodexReferenceRouterPort,
  destination: NodexDestination,
  input: NodexReferenceOpenInput,
): Promise<NodexReferenceOpenOutcome> {
  if (input.isCurrent?.() === false) return "failed";
  if (isOtherSpaceDestination(destination))
    return (await port.openInSpace(buildNodexDestinationLink(destination))) ? "opened" : "failed";
  const decision = decideNodexReferenceOpen({
    destination,
    surface: input.source.surface,
    gesture: input.gesture,
  });
  if (decision.kind === "new-window")
    return (await port.openInNewWindow(destination, input.titleSnapshot)) ? "opened" : "failed";
  if (destination.kind === "session") {
    if (destination.sessionId === input.source.sessionId) return "current";
    return (await port.openSession({
      sessionId: destination.sessionId,
      source: input.source,
      ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    }))
      ? "opened"
      : "failed";
  }
  if (decision.kind !== "content") return "failed";
  if (
    input.source.openInPlace &&
    decision.placement === "source-group" &&
    decision.mode === "durable" &&
    decision.activate
  ) {
    await input.source.openInPlace(destination, input.titleSnapshot);
    return "opened";
  }
  return (await port.presentContent({
    destination,
    source: input.source,
    placement: decision.placement,
    mode: decision.mode,
    activate: decision.activate,
    ...(input.titleSnapshot ? { titleSnapshot: input.titleSnapshot } : {}),
    ...(input.homeProjectId ? { homeProjectId: input.homeProjectId } : {}),
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
  }))
    ? "opened"
    : "failed";
}

const NodexReferenceRouterContext = createContext<NodexReferenceRouter | null>(null);
const DEFAULT_SOURCE: NodexReferenceSource = { surface: "workbench" };
const NodexReferenceSourceContext = createContext<NodexReferenceSource>(DEFAULT_SOURCE);

/** The Workbench provides the one router; a reference outside it is shown, not opened. */
export function NodexReferenceRouterProvider({
  router,
  children,
}: {
  readonly router: NodexReferenceRouter;
  readonly children: ReactNode;
}) {
  return <NodexReferenceRouterContext value={router}>{children}</NodexReferenceRouterContext>;
}

export function useNodexReferenceRouter(): NodexReferenceRouter | null {
  return useContext(NodexReferenceRouterContext);
}

/** A reading surface declares itself once; every reference inside it opens relative to it. */
export function NodexReferenceSourceProvider({
  source,
  children,
}: {
  readonly source: NodexReferenceSource;
  readonly children: ReactNode;
}) {
  return <NodexReferenceSourceContext value={source}>{children}</NodexReferenceSourceContext>;
}

export function useNodexReferenceSource(): NodexReferenceSource {
  return useContext(NodexReferenceSourceContext);
}

export type OpenGuestNodexReference = (
  destination: NodexDestination,
  isCurrent?: () => boolean,
) => Promise<boolean>;

/** Guests request a plain open. Retained guests read the latest committed navigation context. */
export function useGuestNodexReferenceOpener(
  conversationSessionId?: string,
): OpenGuestNodexReference | undefined {
  const router = useNodexReferenceRouter();
  const declaredSource = useNodexReferenceSource();
  const source = conversationSessionId
    ? { surface: "conversation" as const, sessionId: conversationSessionId }
    : declaredSource;
  const context = useRef({ router, source });
  useLayoutEffect(() => {
    context.current = { router, source };
  });
  const open = useCallback<OpenGuestNodexReference>(async (destination, isCurrent) => {
    const { router, source } = context.current;
    if (!router) return false;
    const result = await router.open(destination, {
      source,
      gesture: { kind: "menu", action: "open" },
      isCurrent,
    });
    return result !== "failed";
  }, []);
  return router ? open : undefined;
}
