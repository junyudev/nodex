import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
import type { WorkbenchPanelSide } from "../../shared/workbench-session-view";

export type { WorkbenchPanelSide };

/**
 * How a Session Scene presents its Conversation beside its content panel.
 *
 * | layout | Conversation | content panel                              |
 * | ------ | ------------ | ------------------------------------------ |
 * | chat   | fills        | hidden; its tabs are retained              |
 * | split  | one side     | the other side                             |
 * | full   | a tab        | fills, unless the Chat tab is selected     |
 */
export interface SessionWorkspacePresentation {
  readonly layout: "chat" | "split" | "full";
  /** The surface filling a full view; null outside full view. */
  readonly fullViewSurface: "conversation" | "content" | null;
  /** The physical side of the content panel. The Conversation takes the other side. */
  readonly contentSide: WorkbenchPanelSide;
}

export const DEFAULT_SESSION_CONTENT_SIDE: WorkbenchPanelSide = "right";

export function oppositeWorkbenchPanelSide(side: WorkbenchPanelSide): WorkbenchPanelSide {
  return side === "left" ? "right" : "left";
}

/**
 * A full view keeps `fullWidth` while either surface fills it: collapsing the content panel
 * selects the Chat tab instead of leaving full view.
 */
export function resolveSessionWorkspacePresentation(panel: {
  readonly collapsed: boolean;
  readonly fullWidth: boolean;
  readonly side: WorkbenchPanelSide | undefined;
  readonly preferredSide: WorkbenchPanelSide;
}): SessionWorkspacePresentation {
  const contentSide = panel.side ?? panel.preferredSide;
  if (panel.fullWidth) {
    return {
      layout: "full",
      fullViewSurface: panel.collapsed ? "conversation" : "content",
      contentSide,
    };
  }
  return { layout: panel.collapsed ? "chat" : "split", fullViewSurface: null, contentSide };
}

/** Whether the Conversation is on screen: always, except behind a full-view content tab. */
export function isSessionConversationVisible(presentation: SessionWorkspacePresentation): boolean {
  return presentation.fullViewSurface !== "content";
}

/**
 * The panes a content tab can be presented in beside the Conversation: both, except the pane
 * it already shows in. Only the selected tab of a split view occupies a pane.
 */
export function resolveContentTabPaneMoves(input: {
  readonly presentation: SessionWorkspacePresentation;
  readonly tabSelected: boolean;
}): readonly WorkbenchPanelSide[] {
  const occupied =
    input.presentation.layout === "split" && input.tabSelected
      ? input.presentation.contentSide
      : null;
  return (["left", "right"] as const).filter((side) => side !== occupied);
}

function isWorkbenchPanelSide(value: unknown): value is WorkbenchPanelSide {
  return value === "left" || value === "right";
}

/** The side where content opens in a Session that has not chosen one: the latest choice. */
const sessionContentSidePreferenceAtom = persistedAtom<WorkbenchPanelSide>({
  debugLabel: "session-content-side-preference",
  storageKey: "nodex:session-content-side:v1",
  defaultValue: DEFAULT_SESSION_CONTENT_SIDE,
  hydration: "eager",
  decode: (value) => (isWorkbenchPanelSide(value) ? value : DEFAULT_SESSION_CONTENT_SIDE),
});

export function useSessionContentSidePreference() {
  const loadable = usePersistedAtomValue(sessionContentSidePreferenceAtom);
  const write = useSetPersistedAtom(sessionContentSidePreferenceAtom);
  const update = (side: WorkbenchPanelSide) => {
    void write((current) => (current === side ? current : side)).catch(() => {
      // The Scene keeps its own side; the next choice retries the preference write.
    });
  };
  return { preferredSide: loadable.value, update };
}
