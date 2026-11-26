import { getIntl } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { parseDatabaseViewId } from "../../shared/database-identities";
import type { LibraryRouteTarget } from "../../shared/library-module";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { createNodexReferenceRouter, type NodexReferenceRouter } from "./nodex-reference-router";
import { isRemoteSpace } from "./renderer-space";
import { sessionExecutionThreadId } from "./session-execution";
import type { ExistingSideChatTarget } from "./use-workbench-panel-openers";
import type { WorkbenchSurfaceRelativePlacement } from "./workbench-panel-placement";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { OpenPageInNewWindowHandler } from "./workbench-shell-operations";

/** The options of the Workbench presenter that places Library content into a Scene. */
export interface WorkbenchLibraryContentOptions {
  readonly owner?: WorkbenchSceneOwner;
  readonly blockId?: string;
  readonly titleSnapshot?: string;
  readonly placement?: WorkbenchSurfaceRelativePlacement;
  readonly targetPanelId?: "right";
  readonly mode?: "durable" | "preview";
  readonly tab?: "activate" | "background";
  readonly isCurrent?: () => boolean;
}

/** The Workbench owners every Nodex reference opens through. */
export interface WorkbenchNodexReferenceOwners {
  readonly selectedSceneOwner: () => WorkbenchSceneOwner | null;
  readonly presentLibraryContent: (
    target: LibraryRouteTarget,
    options: WorkbenchLibraryContentOptions,
  ) => Promise<boolean>;
  readonly presentProjectView: (projectId: string, viewId: string) => Promise<boolean>;
  /** The chat whose Scene is selected, with its tabs. */
  readonly readingSession: () => WorkbenchSessionRenderProjection | null;
  readonly openSideChat: (
    target: ExistingSideChatTarget,
    source: WorkbenchSessionRenderProjection,
  ) => Promise<boolean>;
  readonly readSession: (
    sessionId: string,
  ) => Promise<{ readonly projectId: string | null; readonly archived: boolean } | null>;
  readonly bindProjectAgentDock: (projectId: string, sessionId: string) => void;
  /** Goes to the chat's own Scene, leaving any auxiliary route. */
  readonly selectSession: (sessionId: string) => Promise<void>;
  readonly openPageInNewWindow?: OpenPageInNewWindowHandler;
  readonly openSessionInNewWindow?: (sessionId: string) => Promise<boolean>;
  readonly openInSpace: (href: string) => Promise<boolean>;
}

/** Executes the shared reference decision through the Workbench's existing owners. */
export function createWorkbenchNodexReferenceRouter(
  owners: WorkbenchNodexReferenceOwners,
): NodexReferenceRouter {
  return createNodexReferenceRouter({
    presentContent: async (input) => {
      const destination = input.destination;
      const target: LibraryRouteTarget =
        destination.kind === "page"
          ? { kind: "page", pageId: destination.pageId }
          : { kind: "view", viewId: parseDatabaseViewId(destination.viewId) };
      const owner = input.source.owner ?? owners.selectedSceneOwner();
      const options: WorkbenchLibraryContentOptions = {
        // A chat's content panel keeps tabs, not Scene previews: content opens as a tab there,
        // reused when it is already open.
        mode: owner?.kind === "session" ? "durable" : input.mode,
        tab: input.activate ? "activate" : "background",
        ...(input.titleSnapshot ? { titleSnapshot: input.titleSnapshot } : {}),
        ...(destination.kind === "page" && destination.blockId
          ? { blockId: destination.blockId }
          : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
      };
      const homeProjectId = input.placement === "home" ? input.homeProjectId : null;
      let presented: boolean;
      if (homeProjectId)
        // A link from outside opens in the Project it belongs to.
        presented =
          destination.kind === "view"
            ? await owners.presentProjectView(homeProjectId, destination.viewId)
            : await owners.presentLibraryContent(target, {
                ...options,
                owner: { kind: "project", projectId: homeProjectId },
              });
      // Space is every Page's and View's own Scene.
      else if (input.placement === "home" || !owner)
        presented = await owners.presentLibraryContent(target, options);
      else if (input.source.surfaceId)
        presented = await owners.presentLibraryContent(target, {
          ...options,
          owner,
          placement: {
            kind: input.placement === "beside" ? "adjacent-right" : "same-group",
            sourceSurfaceId: input.source.surfaceId,
          },
        });
      // A chat's content panel is beside it.
      else
        presented = await owners.presentLibraryContent(target, {
          ...options,
          owner,
          targetPanelId: "right",
        });
      return presented;
    },
    openSession: async (input) => {
      try {
        return await openSession(owners, input);
      } catch (error) {
        toast.danger(
          error instanceof Error && error.message
            ? error.message
            : getIntl().formatMessage({
                id: "workbench.workbenchRuntime.agentsChatUnavailable",
                defaultMessage: "Couldn’t open chat",
              }),
        );
        return false;
      }
    },
    openInNewWindow: async (destination, titleSnapshot) => {
      if (destination.kind === "page") {
        if (!owners.openPageInNewWindow) return false;
        const source = owners.selectedSceneOwner();
        owners.openPageInNewWindow(
          {
            pageId: destination.pageId,
            ...(titleSnapshot ? { titleSnapshot } : {}),
          },
          source?.kind === "project" ? source : undefined,
        );
        return true;
      }
      if (destination.kind !== "session" || !owners.openSessionInNewWindow) return false;
      return await owners.openSessionInNewWindow(destination.sessionId);
    },
    openInSpace: owners.openInSpace,
  });
}

async function openSession(
  owners: WorkbenchNodexReferenceOwners,
  input: Parameters<Parameters<typeof createNodexReferenceRouter>[0]["openSession"]>[0],
): Promise<boolean> {
  const { sessionId, source, isCurrent } = input;
  const owner = source.owner ?? owners.selectedSceneOwner();
  const reading = owner?.kind === "session" ? owners.readingSession() : null;
  const parentThreadId = reading ? sessionExecutionThreadId(reading) : null;
  // A side chat of the chat being read opens as its tab beside it.
  if (
    reading &&
    parentThreadId &&
    reading.tabs.some((tab) => tab.kind === "side_chat" && tab.config.sessionId === sessionId)
  )
    return await owners.openSideChat({ kind: "runtime", sessionId, parentThreadId }, reading);
  // From the Project Agent Dock, a chat of the same Project becomes its target.
  if (source.surface === "conversation" && owner?.kind === "project" && !isRemoteSpace()) {
    const chat = await owners.readSession(sessionId);
    if (isCurrent?.() === false) return false;
    if (chat?.projectId === owner.projectId && !chat.archived) {
      owners.bindProjectAgentDock(owner.projectId, sessionId);
      return true;
    }
  }
  await owners.selectSession(sessionId);
  return true;
}
