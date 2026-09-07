import { make as makeHandoffStatusTools } from "./HandoffStatusAppTools";
import { make as makeSessionHandoffTools } from "./SessionHandoffAppTools";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { sidebarSchemas } from "../../shared/nodex-app-tools/sidebar-schemas";
import { sessionSchemas } from "../../shared/nodex-app-tools/session-schemas";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AppToolInvocationInbox, type AppToolInvocation } from "./AppToolInvocationInbox";

import { toolFailure as failure, toolSuccess as success } from "./app-tool-result";
import { make as makeContentQueries } from "./ContentQueryAppTools";
import { make as makeContentTools } from "./ContentAppTools";
import { isContentTool } from "../../shared/nodex-app-tools/content-catalog";
import { make as makeTerminalTools } from "./TerminalAppTools";
import { accountSchemas } from "../../shared/nodex-app-tools/account-schemas";
import { make as makeAccountTools } from "./AccountAppTools";
import { make as makeDependencyTools } from "./WorkspaceDependencyAppTools";
import { make as makePluginTools } from "./PluginAppTools";
import { make as makeWorkspaceTools } from "./WorkspaceAppTools";
import { make as makeSessionTools } from "./SessionAppTools";
import { make as makeSessionLaunchTools } from "./SessionLaunchAppTools";
import { make as makeSessionForkTools } from "./SessionForkAppTools";
import { make as makeSessionMessageTools } from "./SessionMessageAppTools";
import { make as makeAutomationTools } from "./AutomationAppTools";
import { make as makeWorkbenchTools } from "./WorkbenchAppTools";
import { workbenchObservationSchemas } from "../../shared/nodex-app-tools/workbench-observation-schemas";
import { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import { sessionPresentationSchemas } from "../../shared/nodex-app-tools/session-presentation-schemas";

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const git = yield* GitWorkerRuntime;
  const contentQueries = yield* makeContentQueries;
  const contentTools = yield* makeContentTools;
  const terminalTools = yield* makeTerminalTools;
  const accountTools = yield* makeAccountTools;
  const dependencyTools = yield* makeDependencyTools;
  const pluginTools = yield* makePluginTools;
  const workspaceTools = yield* makeWorkspaceTools;
  const sessionTools = yield* makeSessionTools;
  const sessionLaunchTools = yield* makeSessionLaunchTools;
  const sessionMessageTools = yield* makeSessionMessageTools;
  const sessionForkTools = yield* makeSessionForkTools;
  const sessionHandoffTools = yield* makeSessionHandoffTools;
  const handoffStatusTools = yield* makeHandoffStatusTools;
  const automationTools = yield* makeAutomationTools;
  const workbenchTools = yield* makeWorkbenchTools;
  return Effect.fn("AppToolInterpreter.execute")(function* (
    input: AppToolInvocation,
  ): Effect.fn.Return<CallToolResult> {
    if (!input.caller.isActive()) return failure("call_withdrawn");
    if (!appToolCatalog.some((tool) => tool.name === input.name)) return failure("unknown_tool");
    if (input.name === "load_workspace_dependencies") return yield* dependencyTools(input);
    const isContentQuery =
      input.name === "query_content" || input.name === "describe_content_schema";
    const isWorkspaceTool =
      Object.hasOwn(sidebarSchemas, input.name) || Object.hasOwn(sessionSchemas, input.name);
    const isSessionObservation = Object.hasOwn(sessionObservationSchemas, input.name);
    const isWorkbenchTool =
      Object.hasOwn(workbenchObservationSchemas, input.name) ||
      Object.hasOwn(workbenchControlSchemas, input.name) ||
      Object.hasOwn(sessionPresentationSchemas, input.name);
    if (
      !isContentQuery &&
      !isContentTool(input.name) &&
      !Object.hasOwn(accountSchemas, input.name) &&
      !isWorkspaceTool &&
      !isSessionObservation &&
      !isWorkbenchTool &&
      input.name !== "create_session" &&
      input.name !== "send_message_to_session" &&
      input.name !== "fork_session" &&
      input.name !== "handoff_session" &&
      input.name !== "get_handoff_status" &&
      input.name !== "automation_update" &&
      input.name !== "read_session_terminal" &&
      input.name !== "uninstall_plugin" &&
      Object.keys(input.arguments).length !== 0
    )
      return failure("invalid_arguments");
    const thread = yield* workspace
      .getThread(input.caller.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!thread || thread.executionHostId !== input.caller.hostId)
      return failure("session_unavailable");
    if (!input.caller.isActive()) return failure("call_withdrawn");
    if (isContentQuery) return yield* contentQueries(input);
    if (isContentTool(input.name)) return yield* contentTools(input);
    if (input.name === "read_session_terminal") return yield* terminalTools(input);
    if (Object.hasOwn(accountSchemas, input.name)) return yield* accountTools(input);
    if (input.name === "uninstall_plugin") return yield* pluginTools(input);
    if (isWorkspaceTool) return yield* workspaceTools(input);
    if (isSessionObservation) return yield* sessionTools(input);
    if (isWorkbenchTool) return yield* workbenchTools(input);
    if (input.name === "automation_update") return yield* automationTools(input);
    if (input.name === "handoff_session") return yield* sessionHandoffTools(input);
    if (input.name === "get_handoff_status") return yield* handoffStatusTools(input);
    if (input.name === "create_session") return yield* sessionLaunchTools(input);
    if (input.name === "fork_session") return yield* sessionForkTools(input);
    if (input.name === "send_message_to_session") return yield* sessionMessageTools(input);
    if (input.name === "get_app_capabilities")
      return success({
        backend: "codex",
        transport: "native_mcp",
        hostId: input.caller.hostId,
        tools: appToolCatalog.map((tool) => tool.name),
        sessionContext: "authorized_workbench_observation",
        contentAccess: "project_sql",
        workbenchControl: "revision_fenced_commands",
        publicSharing: "unavailable",
        cloudTasks: "unavailable",
      });
    if (input.name === "list_projects") {
      const projects = yield* workspace.listProjects.pipe(
        Effect.flatMap((items) =>
          Effect.forEach(
            items,
            (project) =>
              Effect.gen(function* () {
                const metadata = project.primaryWorkspaceRoot
                  ? yield* git
                      .request({
                        method: "stable-metadata",
                        params: { cwd: project.primaryWorkspaceRoot },
                      })
                      .pipe(Effect.catch(() => Effect.succeed(null)))
                  : null;
                return {
                  projectId: project.id,
                  name: project.name,
                  path: project.primaryWorkspaceRoot,
                  hostId: "local",
                  isGitRepository:
                    metadata && !metadata.errorMessage ? metadata.isGitRepository : null,
                  gitStatus: !project.primaryWorkspaceRoot
                    ? "no_workspace"
                    : !metadata || metadata.errorMessage
                      ? "unavailable"
                      : "available",
                };
              }),
            { concurrency: 4 },
          ),
        ),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!input.caller.isActive()) return failure("call_withdrawn");
      if (!projects) return failure("projects_unavailable");
      return success({ projects });
    }
    const context = {
      sessionId: thread.sessionId,
      threadId: input.caller.threadId,
      turnId: input.caller.turnId,
      projectId: thread.projectId,
      hostId: input.caller.hostId,
      cwd: thread.cwd,
    };
    return success(context);
  });
});

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbox = yield* AppToolInvocationInbox;
    const execute = yield* make;
    yield* inbox.invocations.pipe(
      Stream.runForEach((ticket) => inbox.interpret(ticket, execute).pipe(Effect.forkScoped)),
      Effect.forkScoped,
    );
  }),
);
