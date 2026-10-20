import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentHostTool } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import { sidebarSchemas } from "../../shared/nodex-app-tools/sidebar-schemas";
import { sessionSchemas } from "../../shared/nodex-app-tools/session-schemas";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";
import { accountSchemas } from "../../shared/nodex-app-tools/account-schemas";
import { workbenchObservationSchemas } from "../../shared/nodex-app-tools/workbench-observation-schemas";
import { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import { sessionPresentationSchemas } from "../../shared/nodex-app-tools/session-presentation-schemas";
import { makeWithCapture as makeAccount } from "../app-tools/AccountAppTools";
import { makeWithCapture as makeTerminal } from "../app-tools/TerminalAppTools";
import { makeWithCapture as makePlugin } from "../app-tools/PluginAppTools";
import { makeWithCapture as makeWorkspace } from "../app-tools/WorkspaceAppTools";
import { makeWithCapture as makeSession } from "../app-tools/SessionAppTools";
import { makeWithCapture as makeWorkbench } from "../app-tools/WorkbenchAppTools";
import { makeWithCapture as makeAutomation } from "../app-tools/AutomationAppTools";
import { makeWithCapture as makeInbox } from "../app-tools/InboxAppTools";
import { make as makeSessionCommands } from "../app-tools/RuntimeSessionCommands";
import { makeWithCapture as makeHandoff } from "../app-tools/SessionHandoffAppTools";
import { makeWithCapture as makeHandoffStatus } from "../app-tools/HandoffStatusAppTools";
import { make as makeObservation } from "../app-tools/RuntimeSessionObservation";
import { SessionObservation } from "../app-tools/SessionObservation";
import { SessionWaiter, makeWithSources } from "../app-tools/SessionWaiter";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { isContentTool } from "../../shared/nodex-app-tools/content-catalog";
import {
  captureHostedAppToolAuthority,
  readHostedAppToolSessionContext,
  type AppToolCaller,
} from "../app-tools/AppToolCaller";
import { makeWithCapture as makeContentTools } from "../app-tools/ContentAppTools";
import { makeWithCapture as makeContentQueries } from "../app-tools/ContentQueryAppTools";
import { toolFailure, toolSuccess } from "../app-tools/app-tool-result";
import { WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";

const queries = new Set(["query_content", "describe_content_schema"]);
export const runtimeHostToolCatalog: ReadonlyArray<AgentHostTool> = appToolCatalog.map((tool) => ({
  name: tool.name,
  ...(tool.description
    ? {
        description:
          tool.name === "create_session"
            ? "Create and start a Session using the calling Session's provider and model unless model is supplied. Choose the Project and local or worktree environment explicitly. Reuse operationId with identical arguments for retries."
            : tool.name === "fork_session"
              ? "Fork captured conversation history into an independent Session in the source Project. Omit sessionId to fork the exact calling Thread, including an app-owned child. Choose same-directory or worktree explicitly; reuse operationId for retries."
              : tool.name === "send_message_to_session"
                ? "Send a follow-up to another Runtime Session. Omit model to retain its selection; set providerInstanceId and model from list_agent_models to continue it on another Agent with the conversation so far. Reuse operationId with identical arguments for retries; a repeated request never dispatches another message. The calling Session cannot message itself."
                : tool.description,
      }
    : {}),
  inputSchema: tool.inputSchema,
  ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
}));
const names = new Set(runtimeHostToolCatalog.map((tool) => tool.name));

export type AgentRuntimeHostToolExecutor = (
  caller: AppToolCaller,
  name: string,
  input: Record<string, unknown>,
) => Effect.Effect<CallToolResult>;

/** Application content semantics are shared; execution identity comes from the Runtime Host. */
export const make = (options: {
  readonly subscribeExecutionChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
}) =>
  Effect.gen(function* () {
    const content = yield* makeContentTools(captureHostedAppToolAuthority);
    const query = yield* makeContentQueries(captureHostedAppToolAuthority);
    const dependencies = yield* WorkspaceDependencyRuntime;
    const workspace = yield* ProjectWorkspace;
    const git = yield* GitWorkerRuntime;
    const account = yield* makeAccount(captureHostedAppToolAuthority);
    const terminal = yield* makeTerminal(captureHostedAppToolAuthority);
    const plugin = yield* makePlugin(captureHostedAppToolAuthority);
    const workspaceTools = yield* makeWorkspace(captureHostedAppToolAuthority);
    const workbench = yield* makeWorkbench(captureHostedAppToolAuthority);
    const automation = yield* makeAutomation(captureHostedAppToolAuthority);
    const inbox = yield* makeInbox(captureHostedAppToolAuthority);
    const observations = yield* makeObservation;
    const waiter = yield* makeWithSources([], {
      prepareSources: options.subscribeExecutionChanges.pipe(Effect.map((source) => [source])),
    }).pipe(Effect.provideService(SessionObservation, observations));
    const session = yield* makeSession(captureHostedAppToolAuthority).pipe(
      Effect.provideService(SessionObservation, observations),
      Effect.provideService(SessionWaiter, waiter),
    );
    const commands = yield* makeSessionCommands;
    const handoff = yield* makeHandoff(captureHostedAppToolAuthority);
    const handoffStatus = yield* makeHandoffStatus(captureHostedAppToolAuthority);
    return Effect.fn("AgentRuntimeHostTools.execute")(function* (
      caller: AppToolCaller,
      name: string,
      input: Record<string, unknown>,
    ) {
      if (!names.has(name)) return toolFailure("tool_unavailable");
      if (!(yield* captureHostedAppToolAuthority(caller)))
        return toolFailure("authority_unavailable");
      const invocation = { caller, name, arguments: input };
      if (isContentTool(name)) return yield* content(invocation);
      if (queries.has(name)) return yield* query(invocation);
      if (name === "read_session_terminal") return yield* terminal(invocation);
      if (name === "uninstall_plugin") return yield* plugin(invocation);
      if (Object.hasOwn(accountSchemas, name)) return yield* account(invocation);
      if (Object.hasOwn(sidebarSchemas, name) || Object.hasOwn(sessionSchemas, name))
        return yield* workspaceTools(invocation);
      if (Object.hasOwn(sessionObservationSchemas, name)) return yield* session(invocation);
      if (
        Object.hasOwn(workbenchObservationSchemas, name) ||
        Object.hasOwn(workbenchControlSchemas, name) ||
        Object.hasOwn(sessionPresentationSchemas, name)
      )
        return yield* workbench(invocation);
      if (name === "automation_update") return yield* automation(invocation);
      if (name === "send_to_inbox") return yield* inbox(invocation);
      if (name === "handoff_session") return yield* handoff(invocation);
      if (name === "get_handoff_status") return yield* handoffStatus(invocation);
      if (
        name === "create_session" ||
        name === "fork_session" ||
        name === "merge_session_back" ||
        name === "send_message_to_session"
      )
        return yield* commands(invocation);
      if (Object.keys(input).length !== 0) return toolFailure("invalid_arguments");
      if (name === "get_app_capabilities")
        return toolSuccess({
          backend: caller.backend,
          transport: "native_mcp",
          tools: [...names],
          contentAccess: "full_profile",
        });
      if (name === "list_projects") {
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
              { concurrency: 2 },
            ),
          ),
          Effect.catch(() => Effect.succeed(null)),
        );
        return caller.isActive() ? toolSuccess({ projects }) : toolFailure("call_withdrawn");
      }
      if (name === "load_workspace_dependencies") return toolSuccess(yield* dependencies.read);
      const context = readHostedAppToolSessionContext(caller);
      return context ? toolSuccess({ ...context }) : toolFailure("session_unavailable");
    }) satisfies AgentRuntimeHostToolExecutor;
  });
