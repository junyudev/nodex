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
}

/**
 * Names what a window shows, most specific first. A Scene is named by its owner: a chat and
 * its Project, a Project, or the Inbox. Space has no owner root, so it is named by its active
 * surface. Other destinations use their own name. An owner the window has not loaded yet
 * contributes nothing, so the title never names a previous location.
 */
export function resolveWorkbenchWindowTitleParts(
  input: WorkbenchWindowTitleInput,
): readonly string[] {
  const { location } = input;
  switch (location.kind) {
    case "session":
      return input.chat?.sessionId === location.sessionId
        ? [input.chat.title, input.chat.projectName ?? ""]
        : [];
    case "project":
      return input.project?.id === location.projectId ? [input.project.name] : [];
    case "library":
      return input.spaceTrail.length > 0 ? input.spaceTrail : ["Space"];
    case "inbox":
      return ["Inbox"];
    case "empty":
    case "pending-worktree":
      return ["New chat"];
    case "automations":
      return ["Scheduled"];
    case "plugins":
      return ["Plugins"];
    case "insights":
      return ["Insights"];
    case "settings":
      return ["Settings"];
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
