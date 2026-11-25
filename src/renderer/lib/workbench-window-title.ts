import { getIntl, type IntlShape } from "@/lib/i18n";
import { presentSessionTitle } from "@/lib/session-title-presentation";
import type { WorkbenchLocation } from "../../shared/workbench-layout";
import type { CodexRendererOs } from "./codex-window-runtime";

export const APPLICATION_WINDOW_NAME = "Nodex";

const TITLE_SEPARATOR = " — ";

export interface WorkbenchWindowTitleInput {
  readonly location: WorkbenchLocation;
  /** The chat a Session location shows, once the window knows that Session. */
  readonly chat: {
    readonly sessionId: string;
    readonly title: string;
    readonly projectName: string | null;
  } | null;
  /** The Project a Project location shows, once the window knows that Project. */
  readonly project: { readonly id: string; readonly name: string } | null;
  /** Space's active surface as its breadcrumb names it, most specific first. */
  readonly spaceTrail: readonly string[];
  /** The team Space a team window belongs to; a personal window names none. */
  readonly teamSpaceName?: string | null;
}

/**
 * Names what a window shows, most specific first. A Scene is named by its owner: a chat and
 * its Project, a Project, or the Inbox. Space has no owner root, so it is named by its active
 * surface. Other destinations use their own name. An owner the window has not loaded yet
 * contributes nothing, so the title never names a previous location. A team window ends its
 * location with the team Space, whose own name also stands for its Space destination.
 */
export function resolveWorkbenchWindowTitleParts(
  input: WorkbenchWindowTitleInput,
  intl: IntlShape = getIntl(),
): readonly string[] {
  const team = input.teamSpaceName?.trim() || null;
  const parts = resolveLocationTitleParts(input, intl);
  if (!team || parts.length === 0) return parts;
  if (input.location.kind === "library" && input.spaceTrail.length === 0) return [team];
  return [...parts, team];
}

function resolveLocationTitleParts(
  input: WorkbenchWindowTitleInput,
  intl: IntlShape,
): readonly string[] {
  const { location } = input;
  switch (location.kind) {
    case "session":
      return input.chat?.sessionId === location.sessionId
        ? [presentSessionTitle(input.chat.title, intl), input.chat.projectName ?? ""]
        : [];
    case "project":
      return input.project?.id === location.projectId ? [input.project.name] : [];
    case "library":
      return input.spaceTrail.length > 0
        ? input.spaceTrail
        : [
            intl.formatMessage({
              id: "lib.workbenchWindowTitle.space",
              defaultMessage: "Space",
            }),
          ];
    case "inbox":
      return [
        intl.formatMessage({ id: "lib.workbenchWindowTitle.inbox", defaultMessage: "Inbox" }),
      ];
    case "empty":
    case "pending-worktree":
      return [presentSessionTitle(null, intl)];
    case "automations":
      return [
        intl.formatMessage({
          id: "lib.workbenchWindowTitle.automations",
          defaultMessage: "Automations",
        }),
      ];
    case "plugin_app":
      return [location.title];
    case "plugins":
      return [
        intl.formatMessage({
          id: "lib.workbenchWindowTitle.plugins",
          defaultMessage: "Plugins",
        }),
      ];
    case "insights":
      return [
        intl.formatMessage({
          id: "lib.workbenchWindowTitle.insights",
          defaultMessage: "Insights",
        }),
      ];
    case "settled":
      return [
        intl.formatMessage({
          id: "lib.workbenchWindowTitle.settled",
          defaultMessage: "Settled",
        }),
      ];
    case "settings":
      return [
        intl.formatMessage({
          id: "lib.workbenchWindowTitle.settings",
          defaultMessage: "Settings",
        }),
      ];
  }
}

/**
 * The native title for a window's content. macOS names the application in its menu bar and
 * groups windows under its icon, so the title is the content alone; Windows and Linux follow
 * their own convention of ending a window title with the application's name.
 */
export function formatWorkbenchWindowTitle(parts: readonly string[], os: CodexRendererOs): string {
  const content = parts.map((part) => part.replace(/\s+/gu, " ").trim()).filter(Boolean);
  if (content.length === 0) return APPLICATION_WINDOW_NAME;
  return (os === "darwin" ? content : [...content, APPLICATION_WINDOW_NAME]).join(TITLE_SEPARATOR);
}
