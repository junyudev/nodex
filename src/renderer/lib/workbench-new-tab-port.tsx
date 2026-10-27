import { createContext, useContext, useState, type ReactNode } from "react";
import type { PanelDestination } from "@/components/workbench/panel-destination-picker-model";
import type { CommandKeymapState } from "../../shared/command-keybindings";
import type { LibraryRouteTarget } from "../../shared/library-module";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import { planNewTabReplacement } from "./workbench-new-tab-model";
import type { PanelNewTabAction, PanelNewTabActionKind } from "./workbench-panel-actions";
import type { ExecuteWorkbenchUiCommand } from "./use-workbench-scene-commands";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import type { PanelId, Project } from "./types";

/** What a New tab can become. */
export type WorkbenchNewTabIntent =
  | { readonly kind: "action"; readonly action: PanelNewTabActionKind }
  | { readonly kind: "tab"; readonly tabId: string }
  | { readonly kind: "destination"; readonly destination: PanelDestination }
  | {
      readonly kind: "library-target";
      readonly target: LibraryRouteTarget;
      readonly title?: string;
    }
  | { readonly kind: "chat" };

/** Where an intent opens: the New tab's own group. */
export interface WorkbenchNewTabPlacement {
  readonly owner: WorkbenchSceneOwner;
  readonly panelId: PanelId;
  readonly leafId: string;
  /** False once the New tab is gone or hidden; a slow intent then must not present itself. */
  readonly isCurrent: () => boolean;
}

/** The owner-specific capabilities a New tab presents. */
export interface WorkbenchNewTabOwnerContext {
  readonly actions: readonly PanelNewTabAction[];
  readonly currentProjectId: string | null;
  /** True when the owner's Chat is hidden behind a full-width panel. */
  readonly canReturnToChat: boolean;
  /** True when Terminal can also open in the closed bottom panel. */
  readonly canOpenBottomTerminal: boolean;
}

export interface WorkbenchNewTabPort {
  readonly isMac: boolean;
  readonly commandKeymapState: CommandKeymapState | null;
  readonly projects: readonly Project[];
  readonly resolveOwnerContext: (
    owner: WorkbenchSceneOwner,
    panelId: PanelId,
  ) => WorkbenchNewTabOwnerContext | null;
  /** Runs an intent in the New tab's group; its result then takes the New tab's place. */
  readonly open: (input: {
    readonly owner: WorkbenchSceneOwner;
    readonly surfaceId: string;
    readonly intent: WorkbenchNewTabIntent;
  }) => Promise<void>;
  /** Reveals the owner's bottom Terminal, creating one when the bottom panel has none. */
  readonly openBottomTerminal: (owner: WorkbenchSceneOwner) => Promise<void>;
}

/** The owner Scene commands a New tab port delegates to. */
export interface WorkbenchNewTabOwnerCommands {
  readonly resolveOwnerContext: WorkbenchNewTabPort["resolveOwnerContext"];
  /** Opens an action in the placement; resolves false when nothing opened. */
  readonly runAction: (
    action: PanelNewTabActionKind,
    placement: WorkbenchNewTabPlacement,
  ) => Promise<boolean>;
  readonly openDestination: (
    destination: PanelDestination,
    placement: WorkbenchNewTabPlacement,
  ) => Promise<boolean>;
  readonly openLibraryTarget: (
    target: LibraryRouteTarget,
    placement: WorkbenchNewTabPlacement & { readonly title?: string },
  ) => Promise<boolean>;
  /** Shows the owner's Chat beside its panels. */
  readonly returnToChat: () => void;
}

const WorkbenchNewTabPortContext = createContext<WorkbenchNewTabPort | null>(null);

export function WorkbenchNewTabPortProvider({
  port,
  children,
}: {
  readonly port: WorkbenchNewTabPort;
  readonly children: ReactNode;
}) {
  return (
    <WorkbenchNewTabPortContext.Provider value={port}>
      {children}
    </WorkbenchNewTabPortContext.Provider>
  );
}

export function useWorkbenchNewTabPort(): WorkbenchNewTabPort | null {
  return useContext(WorkbenchNewTabPortContext);
}

/**
 * Builds the window's New tab port. Every intent opens in the New tab's group, and the
 * New tab then retires through ordinary Scene commands, so its result keeps the New tab's
 * position and Back/close behave as for any other tab.
 */
export function useWorkbenchNewTabPortValue({
  windowOwner,
  executeSceneCommand,
  isMac,
  commandKeymapState,
  projects,
  commands,
}: {
  readonly windowOwner: WorkbenchWindowOwner;
  readonly executeSceneCommand: ExecuteWorkbenchUiCommand;
  readonly isMac: boolean;
  readonly commandKeymapState: CommandKeymapState | null;
  readonly projects: readonly Project[];
  readonly commands: WorkbenchNewTabOwnerCommands;
}): WorkbenchNewTabPort {
  const { resolveOwnerContext, runAction, openDestination, openLibraryTarget, returnToChat } =
    commands;
  // One intent per New tab at a time: a second click while a Page is being created must not
  // create another one.
  const [pendingSurfaceIds] = useState(() => new Set<string>());
  const observe = (owner: WorkbenchSceneOwner) =>
    readWorkbenchAgentContext(windowOwner.read(), owner);
  const run = async (
    owner: WorkbenchSceneOwner,
    surfaceId: string,
    intent: WorkbenchNewTabIntent,
  ) => {
    const before = observe(owner);
    const group = before?.groups.find((candidate) => candidate.tabIds.includes(surfaceId));
    if (!before || !group) return;
    if (intent.kind === "tab") {
      if (intent.tabId === surfaceId || !before.tabs.some((tab) => tab.tabId === intent.tabId))
        return;
      const activated = await executeSceneCommand(owner, {
        kind: "activate_tab",
        tabId: intent.tabId,
      });
      if (activated.error) return;
      await executeSceneCommand(owner, { kind: "close_tab", tabId: surfaceId });
      return;
    }
    if (intent.kind === "chat") {
      returnToChat();
      await executeSceneCommand(owner, { kind: "close_tab", tabId: surfaceId });
      return;
    }
    const placement = {
      owner,
      panelId: group.panelId,
      leafId: group.groupId,
      isCurrent: () =>
        observe(owner)?.groups.some(
          (candidate) => candidate.visible && candidate.tabIds.includes(surfaceId),
        ) === true,
    };
    const opened =
      intent.kind === "action"
        ? await runAction(intent.action, placement)
        : intent.kind === "destination"
          ? await openDestination(intent.destination, placement)
          : await openLibraryTarget(intent.target, { ...placement, title: intent.title });
    if (!opened) return;

    const plan = planNewTabReplacement({ newTabId: surfaceId, before, after: observe(owner) });
    if (plan.kind === "keep") return;
    if (plan.reorderedTabIds) {
      await executeSceneCommand(owner, {
        kind: "reorder_tabs",
        panelId: group.panelId,
        groupId: plan.groupId,
        tabIds: [...plan.reorderedTabIds],
      });
    }
    await executeSceneCommand(owner, { kind: "close_tab", tabId: surfaceId });
  };
  return {
    isMac,
    commandKeymapState,
    projects,
    resolveOwnerContext,
    open: async ({ owner, surfaceId, intent }) => {
      if (pendingSurfaceIds.has(surfaceId)) return;
      pendingSurfaceIds.add(surfaceId);
      try {
        await run(owner, surfaceId, intent);
      } finally {
        pendingSurfaceIds.delete(surfaceId);
      }
    },
    openBottomTerminal: async (owner) => {
      const observation = observe(owner);
      const terminal = observation?.tabs.find(
        (tab) => tab.panelId === "bottom" && tab.surface?.kind === "terminal",
      );
      if (terminal) {
        await executeSceneCommand(owner, { kind: "activate_tab", tabId: terminal.tabId });
        return;
      }
      const bottom = observation?.panels.find((panel) => panel.panelId === "bottom");
      if (!bottom) return;
      await runAction("terminal", {
        owner,
        panelId: "bottom",
        leafId: bottom.activeGroupId,
        isCurrent: () => true,
      });
    },
  };
}
