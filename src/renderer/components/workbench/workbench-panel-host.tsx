import type { ReactNode } from "react";
import type { AppShellTabItem } from "./app-shell-tabs";
import { PanelGroupTree } from "./panel-group-tree";
import { EmptyRightPane } from "./workbench-panel-controls";
import type { PanelDestination } from "./panel-destination-picker-model";
import type { PanelId, Project, WorkbenchPanelLayout, WorkbenchPanelSplitSide } from "@/lib/types";
import type { CommandKeymapState } from "../../../shared/command-keybindings";
import type { PanelNewTabAction, PanelNewTabActionKind } from "@/lib/workbench-panel-actions";
import { WorkbenchPanelNewTabButton } from "./workbench-panel-new-tab-button";

interface WorkbenchPanelHostCommands {
  readonly selectTab: (leafId: string, tabId: string) => void;
  readonly closeTab: (leafId: string, tabId: string) => void;
  readonly pinTab: (leafId: string, tabId: string) => void;
  readonly reorderTab: (leafId: string, tabId: string, targetIndex: number) => void;
  readonly moveTab: (
    tabId: string,
    targetPanelId: PanelId,
    targetLeafId: string,
    targetIndex?: number,
    splitTarget?: {
      readonly leafId: string;
      readonly side: WorkbenchPanelSplitSide;
    },
  ) => void;
  readonly splitGroup: (leafId: string, side: WorkbenchPanelSplitSide, tabId?: string) => void;
  readonly focusGroup: (leafId: string) => void;
  readonly activateGroup: (leafId: string, tabId?: string | null) => void;
  readonly resizeGroup: (branchId: string, ratio: number) => Promise<void> | void;
  readonly openAction: (action: PanelNewTabActionKind, leafId: string) => void;
  readonly openDestination: (destination: PanelDestination, leafId: string) => Promise<void>;
}

interface WorkbenchPanelHostProps {
  sessionId: string;
  sessionProjectId: string | null;
  panelId: PanelId;
  layout: WorkbenchPanelLayout;
  tabItemsByLeafId: Record<string, AppShellTabItem[]>;
  activeTabIdsByLeafId: Record<string, string | null>;
  availableActions: PanelNewTabAction[];
  projects: Project[];
  isMac: boolean;
  commandKeymapState?: CommandKeymapState | null;
  currentProjectDbViewExists: boolean;
  commands: WorkbenchPanelHostCommands;
  renderAfterList?: (leafId: string) => ReactNode;
  headerStartInsetPx?: number;
  headerEndInsetPx?: number;
  renderNewTab?: (leafId: string) => ReactNode;
  renderEmptyLeaf?: (leafId: string) => ReactNode;
}

export function WorkbenchPanelHost({
  sessionId,
  sessionProjectId,
  panelId,
  layout,
  tabItemsByLeafId,
  activeTabIdsByLeafId,
  availableActions,
  projects,
  isMac,
  commandKeymapState,
  currentProjectDbViewExists,
  commands,
  renderAfterList,
  headerStartInsetPx,
  headerEndInsetPx,
  renderNewTab,
  renderEmptyLeaf,
}: WorkbenchPanelHostProps) {
  return (
    <PanelGroupTree
      sessionId={sessionId}
      panelId={panelId}
      layout={layout}
      tabItemsByLeafId={tabItemsByLeafId}
      activeTabIdsByLeafId={activeTabIdsByLeafId}
      renderAfterTabs={(leafId) =>
        renderNewTab?.(leafId) ?? (
          <WorkbenchPanelNewTabButton
            actions={availableActions}
            projects={projects}
            panelId={panelId}
            currentProjectId={sessionProjectId}
            currentProjectDbViewExists={currentProjectDbViewExists}
            isMac={isMac}
            commandKeymapState={commandKeymapState}
            onAction={(action) => commands.openAction(action, leafId)}
            onOpenDestination={(destination) => commands.openDestination(destination, leafId)}
          />
        )
      }
      renderAfterList={renderAfterList}
      headerStartInsetPx={headerStartInsetPx}
      headerEndInsetPx={headerEndInsetPx}
      renderEmptyLeaf={(leafId) =>
        renderEmptyLeaf?.(leafId) ?? (
          <EmptyRightPane
            actions={availableActions}
            projects={projects}
            isMac={isMac}
            commandKeymapState={commandKeymapState}
            currentProjectId={sessionProjectId}
            currentProjectDbViewExists={currentProjectDbViewExists}
            onAction={(action) => commands.openAction(action, leafId)}
            onOpenDestination={(destination) => commands.openDestination(destination, leafId)}
          />
        )
      }
      onSelectTab={commands.selectTab}
      onCloseTab={commands.closeTab}
      onDirectCloseTab={commands.closeTab}
      onPinTab={commands.pinTab}
      onReorderTab={commands.reorderTab}
      onMoveTab={commands.moveTab}
      onSplitGroup={commands.splitGroup}
      onFocusGroup={commands.focusGroup}
      onActivateGroup={commands.activateGroup}
      onResizeGroup={commands.resizeGroup}
    />
  );
}
