import { make as makeContentTools } from "../../host/HostContentTools";
import type { AppToolInvocation } from "../app-tools/AppToolInvocationInbox";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  makeControlsWithCapture as makeSessionControls,
  makeCommands as makeSessionCommands,
} from "../app-tools/NativeSessionTools";
import * as Effect from "effect/Effect";
import { makeWithCapture as makeAccount } from "../app-tools/AccountAppTools";
import { makeWithCapture as makeTerminal } from "../app-tools/TerminalAppTools";
import { makeWithCapture as makePlugin } from "../app-tools/PluginAppTools";
import { makeWithCapture as makeWorkspace } from "../app-tools/WorkspaceAppTools";
import { makeWithCapture as makeSession } from "../app-tools/SessionAppTools";
import { makeWithCapture as makeWorkbench } from "../app-tools/WorkbenchAppTools";

import { makeWithCapture as makeHandoff } from "../app-tools/SessionHandoffAppTools";
import { makeWithCapture as makeHandoffStatus } from "../app-tools/HandoffStatusAppTools";
import { make as makeObservation } from "../app-tools/NativeSessionObservation";
import { SessionObservation } from "../app-tools/SessionObservation";
import { SessionWaiter, make as makeWaiter } from "../app-tools/SessionWaiter";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { appToolGroups } from "../../shared/nodex-app-tools/catalog";
import { captureHostedAppToolAuthority, type AppToolCaller } from "../app-tools/AppToolCaller";
import { toolFailure, toolSuccess } from "../app-tools/app-tool-result";

import {
  hostToolGroupByName,
  type AgentRuntimeHostToolExecutor,
} from "../../host/HostToolExecutor";
/** Application content semantics are shared; execution identity comes from the Runtime Host. */
export const make = Effect.gen(function* () {
  const content = yield* makeContentTools;
  const workspace = yield* ProjectWorkspace;
  const git = yield* GitWorkerRuntime;
  const account = yield* makeAccount(captureHostedAppToolAuthority);
  const terminal = yield* makeTerminal(captureHostedAppToolAuthority);
  const plugin = yield* makePlugin(captureHostedAppToolAuthority);
  const workspaceTools = yield* makeWorkspace(captureHostedAppToolAuthority);
  const workbench = yield* makeWorkbench(captureHostedAppToolAuthority);
  const observations = yield* makeObservation;
  const waiter = yield* makeWaiter.pipe(Effect.provideService(SessionObservation, observations));
  const session = yield* makeSession(captureHostedAppToolAuthority).pipe(
    Effect.provideService(SessionObservation, observations),
    Effect.provideService(SessionWaiter, waiter),
  );
  const commands = yield* makeSessionCommands;
  const sessionControls = yield* makeSessionControls(captureHostedAppToolAuthority);
  const handoff = yield* makeHandoff(captureHostedAppToolAuthority);
  const handoffStatus = yield* makeHandoffStatus(captureHostedAppToolAuthority);
  const basic = Effect.fn("AgentRuntimeHostTools.basic")(function* (invocation: AppToolInvocation) {
    const { caller, name, arguments: input } = invocation;
    if (Object.keys(input).length !== 0) return toolFailure("invalid_arguments");
    if (name === "get_app_capabilities")
      return toolSuccess({
        backend: caller.backend,
        transport: "native_mcp",
        tools: [...hostToolGroupByName.keys()],
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
    return toolFailure("tool_unavailable");
  });
  // Exhaustiveness ties advertisement to execution: a new group requires its executor here.
  const executors = {
    ...content,
    terminal,
    plugin,
    sessionControls,
    account,
    workspace: workspaceTools,
    session,
    workbench,
    handoff,
    handoffStatus,
    sessionCommands: commands,
    basic,
  } satisfies Record<
    keyof typeof appToolGroups,
    (input: AppToolInvocation) => Effect.Effect<CallToolResult>
  >;
  return Effect.fn("AgentRuntimeHostTools.execute")(function* (
    caller: AppToolCaller,
    name: string,
    input: Record<string, unknown>,
  ) {
    const group = hostToolGroupByName.get(name);
    if (!group) return toolFailure("tool_unavailable");
    if (!(yield* captureHostedAppToolAuthority(caller)))
      return toolFailure("authority_unavailable");
    return yield* executors[group]({ caller, name, arguments: input });
  }) satisfies AgentRuntimeHostToolExecutor;
});
