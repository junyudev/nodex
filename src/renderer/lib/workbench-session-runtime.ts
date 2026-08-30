import type { CodexForkBrowserSceneContext } from "../../shared/codex-fork-browser-transfer";
import type {
  ProjectSession,
  ProjectSessionForkInput,
  ProjectSessionForkResult,
  ProjectSessionSummaryWindow,
  ProjectSessionSummaryWindowInput,
} from "../../shared/types";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const ensureThreadSessionCommand = defineRendererCommand({
  key: "workbench_session.ensure_thread_session",
  channel: "codex:thread:ensure-session",
  authority: "main",
  owner: "WorkbenchSessionCatalog",
  protocol: { kind: "returned_value" },
});

const forkProjectSessionCommand = defineRendererCommand({
  key: "workbench_session.fork",
  channel: "project-sessions:fork",
  authority: "external",
  owner: "WorkbenchSessionCatalog",
  protocol: { kind: "pending_operation" },
});

export function listWorkbenchSessions(
  projectId: string | null,
  input?: ProjectSessionSummaryWindowInput,
): Promise<ProjectSessionSummaryWindow> {
  return invokeRendererQuery("workspace:tasks:list", projectId, input);
}

export function ensureWorkbenchThreadSession(threadId: string): Promise<ProjectSession | null> {
  return invokePlainCommand(ensureThreadSessionCommand, threadId);
}

export function forkWorkbenchSession(
  sessionId: string,
  input: ProjectSessionForkInput,
  sourceSceneContext?: CodexForkBrowserSceneContext,
): Promise<ProjectSessionForkResult> {
  return invokePlainCommand(forkProjectSessionCommand, sessionId, input, sourceSceneContext);
}
