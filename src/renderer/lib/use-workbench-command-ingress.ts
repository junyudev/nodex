import { rendererSpaceId, isRemoteSpace } from "./renderer-space";
import {
  switchSpace,
  switchSpaceForNotification,
  takeSpaceNotification,
} from "@/features/spaces/spaces-runtime";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";
import type {
  WorkbenchNavigationCommandSource,
  WorkbenchNavigationDirection,
  WorkbenchPanelTabCycleDirection,
  WorkbenchSidebarToggleCommandSource,
  WorkbenchThreadRenameCommandSource,
} from "../../shared/window-navigation";
import type {
  WorkbenchCommandId,
  WorkbenchCommandInvocation,
  WorkbenchCommandSource,
} from "../../shared/workbench-commands";
import type {
  ContentSearchDomain,
  ContentSearchOpenSource,
} from "@/features/content-search/content-search-context";
import type { CommandMenuOpenRequest } from "./command-palette";
import type { DesktopNotificationActionInvocation } from "../../shared/types";
import { subscribeDesktopNotificationActions } from "./api";

export interface WorkbenchCommandPort {
  readonly navigate: (
    direction: WorkbenchNavigationDirection,
    source: WorkbenchNavigationCommandSource,
  ) => void;
  readonly toggleSidebar: (source: WorkbenchSidebarToggleCommandSource) => void;
  readonly renameThread: (source: WorkbenchThreadRenameCommandSource) => void;
  readonly openContentSearch: (
    source: ContentSearchOpenSource,
    preferredDomain?: ContentSearchDomain,
  ) => void;
  readonly cyclePanelTab: (direction: WorkbenchPanelTabCycleDirection) => void;
  readonly closePanelTab: () => void;
  readonly execute: (commandId: WorkbenchCommandId, source: WorkbenchCommandSource) => boolean;
  readonly openCommandPalette: (request?: CommandMenuOpenRequest) => void;
  readonly goToPages: () => void;
  readonly goToInsights: () => void;
  readonly goToSettings: () => void;
  readonly toggleSettings: () => void;
  readonly openKeyboardShortcuts: () => void;
  readonly openDesktopNotification: (
    invocation: DesktopNotificationActionInvocation,
  ) => void | Promise<void>;
}

export interface WorkbenchCommandDispatcher extends WorkbenchCommandPort {
  readonly register: (port: WorkbenchCommandPort) => () => void;
}

export interface WorkbenchReminderOpenRequest {
  readonly spaceId?: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly occurrenceStart: string;
}

export interface WorkbenchPageDeepLinkRequest {
  readonly spaceId?: string;
  readonly projectId: string;
  readonly pageId: string;
}

export function reminderOpenToPageDeepLink(
  request: WorkbenchReminderOpenRequest,
): WorkbenchPageDeepLinkRequest {
  return {
    projectId: request.projectId,
    pageId: request.pageId,
  };
}

export interface WorkbenchSessionDeepLinkRequest {
  readonly spaceId?: string;
  readonly projectId: string | null;
  readonly sessionId: string;
}

export interface WorkbenchViewDeepLinkRequest {
  readonly spaceId?: string;
  readonly projectId: string;
  readonly viewId: string;
}

export interface WorkbenchExternalIngressHandlers {
  readonly onReminderOpen?: (request: WorkbenchReminderOpenRequest) => void;
  readonly onPageDeepLinkOpen?: (request: WorkbenchPageDeepLinkRequest) => void;
  readonly onSessionDeepLinkOpen?: (request: WorkbenchSessionDeepLinkRequest) => void;
  readonly onViewDeepLinkOpen?: (request: WorkbenchViewDeepLinkRequest) => void;
  readonly onRequestNewWindow?: () => void;
}

function parseReminderOpenRequest(value: unknown): WorkbenchReminderOpenRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (typeof request.projectId !== "string") return null;
  if (typeof request.pageId !== "string") return null;
  if (request.spaceId !== undefined && (typeof request.spaceId !== "string" || !request.spaceId))
    return null;
  if (typeof request.occurrenceStart !== "string") return null;
  return {
    projectId: request.projectId,
    pageId: request.pageId,
    occurrenceStart: request.occurrenceStart,
    ...(typeof request.spaceId === "string" ? { spaceId: request.spaceId } : {}),
  };
}

function parsePageDeepLinkRequest(value: unknown): WorkbenchPageDeepLinkRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (typeof request.projectId !== "string") return null;
  if (typeof request.pageId !== "string") return null;
  if (request.spaceId !== undefined && (typeof request.spaceId !== "string" || !request.spaceId))
    return null;
  return {
    ...(typeof request.spaceId === "string" ? { spaceId: request.spaceId } : {}),
    projectId: request.projectId,
    pageId: request.pageId,
  };
}

function parseSessionDeepLinkRequest(value: unknown): WorkbenchSessionDeepLinkRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (typeof request.projectId !== "string" && request.projectId !== null) {
    return null;
  }
  if (typeof request.sessionId !== "string") return null;
  if (request.spaceId !== undefined && (typeof request.spaceId !== "string" || !request.spaceId))
    return null;
  return {
    ...(typeof request.spaceId === "string" ? { spaceId: request.spaceId } : {}),
    projectId: request.projectId,
    sessionId: request.sessionId,
  };
}

function parseViewDeepLinkRequest(value: unknown): WorkbenchViewDeepLinkRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (typeof request.projectId !== "string") return null;
  if (typeof request.viewId !== "string") return null;
  if (request.spaceId !== undefined && (typeof request.spaceId !== "string" || !request.spaceId))
    return null;
  return {
    ...(typeof request.spaceId === "string" ? { spaceId: request.spaceId } : {}),
    projectId: request.projectId,
    viewId: request.viewId,
  };
}

function parsePendingSpaceLink(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The Window-scoped Adapter for every native Workbench ingress. Menu commands
 * go through the registered command port; reminder and deep-link payloads are
 * validated here before they cross into renderer-owned navigation.
 */
export function useWorkbenchCommandIngress(
  externalHandlers: WorkbenchExternalIngressHandlers = {},
): WorkbenchCommandDispatcher {
  const portRef = useRef<WorkbenchCommandPort | null>(null);
  const pendingDesktopNotificationInvocationsRef = useRef<DesktopNotificationActionInvocation[]>(
    [],
  );
  const desktopNotificationExecutionRef = useRef<Promise<void>>(Promise.resolve());

  const scheduleDesktopNotification = useCallback(
    (invocation: DesktopNotificationActionInvocation): void => {
      desktopNotificationExecutionRef.current = desktopNotificationExecutionRef.current
        .then(async () => {
          const port = portRef.current;
          if (!port) {
            pendingDesktopNotificationInvocationsRef.current.push(invocation);
            return;
          }
          await port.openDesktopNotification(invocation);
        })
        .catch((error: unknown) => {
          console.warn("[desktop-notifications] Workbench action failed", {
            actionType: invocation.actionType,
            notificationId: invocation.notificationId,
            error,
          });
        });
    },
    [],
  );

  const register = useCallback(
    (port: WorkbenchCommandPort) => {
      portRef.current = port;
      const pending = pendingDesktopNotificationInvocationsRef.current.splice(0);
      for (const invocation of pending) {
        scheduleDesktopNotification(invocation);
      }
      return () => {
        if (portRef.current !== port) return;
        portRef.current = null;
      };
    },
    [scheduleDesktopNotification],
  );

  const navigate = useCallback<WorkbenchCommandPort["navigate"]>(
    (direction, source) => portRef.current?.navigate(direction, source),
    [],
  );
  const toggleSidebar = useCallback<WorkbenchCommandPort["toggleSidebar"]>(
    (source) => portRef.current?.toggleSidebar(source),
    [],
  );
  const renameThread = useCallback<WorkbenchCommandPort["renameThread"]>(
    (source) => portRef.current?.renameThread(source),
    [],
  );
  const openContentSearch = useCallback<WorkbenchCommandPort["openContentSearch"]>(
    (source, preferredDomain) => portRef.current?.openContentSearch(source, preferredDomain),
    [],
  );
  const cyclePanelTab = useCallback<WorkbenchCommandPort["cyclePanelTab"]>(
    (direction) => portRef.current?.cyclePanelTab(direction),
    [],
  );
  const closePanelTab = useCallback<WorkbenchCommandPort["closePanelTab"]>(
    () => portRef.current?.closePanelTab(),
    [],
  );
  const execute = useCallback<WorkbenchCommandPort["execute"]>(
    (commandId, source) => portRef.current?.execute(commandId, source) ?? false,
    [],
  );
  const openCommandPalette = useCallback<WorkbenchCommandPort["openCommandPalette"]>(
    (request) => portRef.current?.openCommandPalette(request),
    [],
  );
  const goToInsights = useCallback<WorkbenchCommandPort["goToInsights"]>(
    () => portRef.current?.goToInsights(),
    [],
  );
  const goToPages = useCallback<WorkbenchCommandPort["goToPages"]>(
    () => portRef.current?.goToPages(),
    [],
  );
  const goToSettings = useCallback<WorkbenchCommandPort["goToSettings"]>(
    () => portRef.current?.goToSettings(),
    [],
  );
  const toggleSettings = useCallback<WorkbenchCommandPort["toggleSettings"]>(
    () => portRef.current?.toggleSettings(),
    [],
  );
  const openKeyboardShortcuts = useCallback<WorkbenchCommandPort["openKeyboardShortcuts"]>(
    () => portRef.current?.openKeyboardShortcuts(),
    [],
  );
  const openDesktopNotification = useCallback<WorkbenchCommandPort["openDesktopNotification"]>(
    (invocation) => {
      if (invocation.spaceId && invocation.spaceId !== rendererSpaceId())
        return switchSpaceForNotification({ ...invocation, spaceId: invocation.spaceId });
      if (!invocation.spaceId && isRemoteSpace()) return;
      if (!portRef.current) {
        pendingDesktopNotificationInvocationsRef.current.push(invocation);
        return;
      }
      scheduleDesktopNotification(invocation);
    },
    [scheduleDesktopNotification],
  );
  const onReminderOpen = useEffectEvent((value: unknown) => {
    const request = parseReminderOpenRequest(value);
    if (!request) return;
    if (!request.spaceId && isRemoteSpace()) return;
    if (request.spaceId && request.spaceId !== rendererSpaceId()) {
      void switchSpace(request.spaceId, { kind: "page", ...request });
      return;
    }
    externalHandlers.onReminderOpen?.(request);
  });
  const onPageDeepLinkOpen = useEffectEvent((value: unknown) => {
    const request = parsePageDeepLinkRequest(value);
    if (!request) return;
    if (request.spaceId && request.spaceId !== rendererSpaceId()) {
      void switchSpace(request.spaceId, { ...request, kind: "page" });
      return;
    }
    externalHandlers.onPageDeepLinkOpen?.(request);
  });
  const onSessionDeepLinkOpen = useEffectEvent((value: unknown) => {
    const request = parseSessionDeepLinkRequest(value);
    if (!request) return;
    if (request.spaceId && request.spaceId !== rendererSpaceId()) {
      void switchSpace(request.spaceId, { ...request, kind: "session" });
      return;
    }
    externalHandlers.onSessionDeepLinkOpen?.(request);
  });
  const onViewDeepLinkOpen = useEffectEvent((value: unknown) => {
    const request = parseViewDeepLinkRequest(value);
    if (!request) return;
    if (request.spaceId && request.spaceId !== rendererSpaceId()) {
      void switchSpace(request.spaceId, { ...request, kind: "view" });
      return;
    }
    externalHandlers.onViewDeepLinkOpen?.(request);
  });
  const onRequestNewWindow = useEffectEvent(() => {
    externalHandlers.onRequestNewWindow?.();
  });

  useEffect(() => {
    const notification = takeSpaceNotification();
    if (notification) void openDesktopNotification(notification);
    const url = new URL(window.location.href);
    const pending = url.searchParams.get("spaceLink");
    if (!pending) return;
    url.searchParams.delete("spaceLink");
    window.history.replaceState(null, "", url);
    const value = parsePendingSpaceLink(pending);
    if (
      !value ||
      typeof value !== "object" ||
      !("spaceId" in value) ||
      value.spaceId !== rendererSpaceId() ||
      !("kind" in value)
    )
      return;
    if (value.kind === "page") onPageDeepLinkOpen(value);
    if (value.kind === "session") onSessionDeepLinkOpen(value);
    if (value.kind === "view") onViewDeepLinkOpen(value);
  }, [openDesktopNotification]);
  useEffect(() => window.api?.onNavigateBack?.(() => navigate("back", "menu")), [navigate]);
  useEffect(() => window.api?.onNavigateForward?.(() => navigate("forward", "menu")), [navigate]);
  useEffect(() => window.api?.onToggleSidebar?.(() => toggleSidebar("menu")), [toggleSidebar]);
  useEffect(() => window.api?.onRenameThread?.(() => renameThread("menu")), [renameThread]);
  useEffect(
    () => window.api?.onOpenContentSearch?.(() => openContentSearch("menu")),
    [openContentSearch],
  );
  useEffect(
    () => window.api?.onCyclePanelTabPrevious?.(() => cyclePanelTab("previous")),
    [cyclePanelTab],
  );
  useEffect(() => window.api?.onCyclePanelTabNext?.(() => cyclePanelTab("next")), [cyclePanelTab]);
  useEffect(() => window.api?.onClosePanelTab?.(closePanelTab), [closePanelTab]);
  useEffect(
    () =>
      window.api?.onWorkbenchCommand?.((invocation: WorkbenchCommandInvocation) =>
        execute(invocation.commandId, invocation.source),
      ),
    [execute],
  );
  useEffect(() => {
    if (!window.api?.on) return undefined;
    return window.api.on("reminder:open", (value: unknown) => {
      onReminderOpen(value);
    });
  }, []);
  useEffect(() => {
    if (!window.api?.on) return undefined;
    return window.api.on("deeplink:open-view", (value: unknown) => {
      onViewDeepLinkOpen(value);
    });
  }, []);
  useEffect(() => {
    if (!window.api?.on) return undefined;
    return window.api.on("deeplink:open-page", (value: unknown) => {
      onPageDeepLinkOpen(value);
    });
  }, []);
  useEffect(() => {
    if (!window.api?.on) return undefined;
    return window.api.on("deeplink:open-session", (value: unknown) => {
      onSessionDeepLinkOpen(value);
    });
  }, []);
  useEffect(() => window.api?.onRequestNewWindow?.(onRequestNewWindow), []);
  useEffect(
    () =>
      subscribeDesktopNotificationActions((invocation) => {
        void openDesktopNotification(invocation);
      }),
    [openDesktopNotification],
  );

  return useMemo(
    () => ({
      register,
      navigate,
      toggleSidebar,
      renameThread,
      openContentSearch,
      cyclePanelTab,
      closePanelTab,
      execute,
      openCommandPalette,
      goToPages,
      goToInsights,
      goToSettings,
      toggleSettings,
      openKeyboardShortcuts,
      openDesktopNotification,
    }),
    [
      closePanelTab,
      cyclePanelTab,
      execute,
      goToPages,
      goToInsights,
      goToSettings,
      navigate,
      openCommandPalette,
      openContentSearch,
      openKeyboardShortcuts,
      openDesktopNotification,
      register,
      renameThread,
      toggleSettings,
      toggleSidebar,
    ],
  );
}
