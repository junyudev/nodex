import { useEffect } from "react";
import type { WorkbenchLocation } from "../../../shared/workbench-layout";
import type { WorkbenchSceneSnapshot } from "../../../shared/workbench-scene";
import { resolveCodexRendererOs } from "@/lib/codex-window-runtime";
import { presentChatTitle } from "@/lib/page-stage-related-chat-candidates";
import type { Project, ProjectSession } from "@/lib/types";
import {
  APPLICATION_WINDOW_NAME,
  formatWorkbenchWindowTitle,
  resolveWorkbenchWindowTitleParts,
} from "@/lib/workbench-window-title";
import { useCurrentSpace } from "@/features/spaces/spaces-runtime";
import { useLibrarySceneTitles } from "./library-scene-breadcrumb";

interface WorkbenchWindowTitleProps {
  readonly location: WorkbenchLocation;
  readonly session: Pick<ProjectSession, "id" | "displayTitle" | "noThreadFallbackTitle"> | null;
  readonly sessionProject: Pick<Project, "name"> | null;
  readonly project: Pick<Project, "id" | "name"> | null;
  readonly libraryScene: WorkbenchSceneSnapshot | null;
}

/**
 * Publishes what the window shows as its document title, which the Desktop Host presents as
 * the native window title in the Window menu, Mission Control, the Dock and window switchers.
 */
export function WorkbenchWindowTitle({
  location,
  session,
  sessionProject,
  project,
  libraryScene,
}: WorkbenchWindowTitleProps) {
  const space = useLibrarySceneTitles(location.kind === "library" ? libraryScene : null);
  const currentSpace = useCurrentSpace();
  const title = formatWorkbenchWindowTitle(
    resolveWorkbenchWindowTitleParts({
      location,
      chat: session
        ? {
            sessionId: session.id,
            title: presentChatTitle(session),
            projectName: sessionProject?.name ?? null,
          }
        : null,
      project,
      spaceTrail: space.surface
        ? space.childTitle
          ? [space.childTitle, space.rootTitle]
          : [space.rootTitle]
        : [],
      teamSpaceName: currentSpace.kind === "team" ? currentSpace.name : null,
    }),
    resolveCodexRendererOs(),
  );
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(
    () => () => {
      document.title = APPLICATION_WINDOW_NAME;
    },
    [],
  );
  return null;
}
