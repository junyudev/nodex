import type {
  CodexSidebarThreadMoveInput,
  CodexSidebarThreadMoveResult,
} from "../../shared/codex-sidebar-thread-move";
import type { WindowSessionNewWindowRequest } from "../../shared/window-session";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

const moveSidebarThreadCommand = defineRendererCommand({
  key: "workbench_sidebar.move_thread",
  channel: "codex:sidebar:thread:move",
  authority: "main",
  owner: "WorkbenchSidebarController",
  protocol: { kind: "returned_value" },
});

const archiveCodexThreadCommand = defineRendererCommand({
  key: "workbench_sidebar.archive_thread",
  channel: "codex:thread:archive",
  authority: "external",
  owner: "WorkbenchSidebarController",
  protocol: { kind: "returned_value" },
});

const openWorkbenchWindowCommand = defineRendererCommand({
  key: "workbench_window.open",
  channel: "window:new",
  authority: "main",
  owner: "WorkbenchShell",
  protocol: { kind: "returned_value" },
});

const pickProjectSourceRootsCommand = defineRendererCommand({
  key: "project_sources.pick_roots",
  channel: "projects:pick-source-roots",
  authority: "external",
  owner: "ProjectSourcesEditor",
  protocol: { kind: "returned_value" },
});

export function moveWorkbenchSidebarThread(
  input: CodexSidebarThreadMoveInput,
): Promise<CodexSidebarThreadMoveResult> {
  return invokePlainCommand(moveSidebarThreadCommand, input);
}

export function archiveWorkbenchThread(threadId: string): Promise<boolean> {
  return invokePlainCommand(archiveCodexThreadCommand, threadId);
}

export function openWorkbenchWindow(request?: WindowSessionNewWindowRequest): Promise<boolean> {
  return invokePlainCommand(openWorkbenchWindowCommand, request);
}

export function pickProjectSourceRoots(): Promise<string[]> {
  return invokePlainCommand(pickProjectSourceRootsCommand);
}
