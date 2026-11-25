import { createContext, useContext } from "react";
import type { AgentsMapScope } from "../../shared/agents-map";
import type { WorkbenchSceneSnapshot } from "../../shared/workbench-scene";
import type { PanelId } from "./types";
import type { WorkbenchSceneNavigator } from "./workbench-scene-navigator";

export interface OpenAgentsTabOptions {
  readonly scope?: AgentsMapScope;
  /** A Session's new-tab menu can request a particular panel group. */
  readonly panelId?: PanelId;
  readonly leafId?: string;
  readonly isCurrent?: () => boolean;
}

export type OpenOrFocusAgentsTab = (options?: OpenAgentsTabOptions) => Promise<boolean>;

export const OpenAgentsTabContext = createContext<OpenOrFocusAgentsTab | null>(null);

/** The command for the Scene currently showing in this Workbench. */
export function useOpenOrFocusAgentsTab(): OpenOrFocusAgentsTab | null {
  return useContext(OpenAgentsTabContext);
}

export async function openOrFocusAgentsTab(
  navigator: Pick<WorkbenchSceneNavigator, "presentPanelSurface">,
  scene: WorkbenchSceneSnapshot,
  sessionProjectId: string | null,
  { scope, panelId = "right", leafId, isCurrent }: OpenAgentsTabOptions = {},
): Promise<boolean> {
  const { owner, primary } = scene;
  if (owner.kind === "library") return false;
  const projectId =
    owner.kind === "project" ? owner.projectId : owner.kind === "session" ? sessionProjectId : null;
  const result = await navigator.presentPanelSurface({
    owner,
    request: { kind: "agents", config: scope ?? { projectId } },
    target:
      primary?.kind === "inbox"
        ? { panelId: "right", placement: { kind: "adjacent-right", sourceSurfaceId: primary.id } }
        : { panelId, leafId },
    mode: "durable",
    navigation: "background",
    isCurrent,
  });
  return result.status === "presented";
}
