import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import { CodexProjectSessionFork } from "../codex-application/CodexProjectSessionFork";
import { SessionWaiter } from "./SessionWaiter";
import { CodexSessionThreadLaunch } from "../codex-application/CodexSessionThreadLaunch";
import { ProjectSessionCommands } from "../project-application/ProjectSessionCommands";
import { SessionObservation } from "./SessionObservation";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Project } from "../../shared/types";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./AppToolInterpreter";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { CodexAccount } from "../codex-application/CodexAccount";
import { WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";
import { ComposerCatalog } from "../codex-application/ComposerCatalog";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchObservation } from "./WorkbenchObservation";
import { WorkbenchContentAccess } from "./WorkbenchContentAccess";
import { createNativeAppToolClaimIssuer } from "./AppToolCaller";

const input: AppToolInvocation = {
  name: "get_session_context",
  arguments: {},
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};

const interpreter = (options: { hostId?: string; afterRead?: () => void } = {}) =>
  make
    .pipe(
      Effect.provideService(NodexAgentApplication, {} as never),
      Effect.provideService(TerminalSessions, {} as never),
      Effect.provideService(CodexAccount, {} as never),
      Effect.provideService(WorkspaceDependencyRuntime, {} as never),
      Effect.provideService(ComposerCatalog, {} as never),
    )
    .pipe(
      Effect.provideService(CodexTurnPresentation, {} as never),
      Effect.provideService(NodexAppToolAuthority, {} as never),
      Effect.provideService(WorkbenchAgentBridge, {} as never),
      Effect.provideService(WorkbenchObservation, {} as never),
      Effect.provideService(WorkbenchContentAccess, {} as never),
      Effect.provideService(CoreAuthority, {} as never),
      Effect.provideService(CodexThreadHandoffRuntime, {} as never),
      Effect.provideService(ProjectSessionCommands, {} as never),
      Effect.provideService(SessionObservation, {} as never),
      Effect.provideService(SessionWaiter, {} as never),
      Effect.provideService(CodexSessionThreadLaunch, {} as never),
      Effect.provideService(CodexTurnCommands, {} as never),
      Effect.provideService(CodexProjectSessionFork, {} as never),
      Effect.provideService(CoreModules, {} as never),
      Effect.provideService(AutomationApplication, {} as never),
      Effect.provideService(CodexTurnAuthority, {} as never),
      Effect.provideService(ProjectWorkspace, {
        getThread: () =>
          Effect.sync(() => {
            options.afterRead?.();
            return {
              sessionId: "session",
              projectId: "project",
              executionHostId: options.hostId ?? "local",
              cwd: "/project",
            };
          }),
        listProjects: Effect.succeed([
          { id: "git", name: "Git", primaryWorkspaceRoot: "/git" },
          { id: "plain", name: "Plain", primaryWorkspaceRoot: "/plain" },
          { id: "missing", name: "Missing", primaryWorkspaceRoot: "/missing" },
          { id: "pages", name: "Pages", primaryWorkspaceRoot: null },
        ] as Project[]),
      } as unknown as ProjectWorkspaceService),
      Effect.provideService(GitWorkerRuntime, {
        handleRendererMessage: () => Effect.void,
        request: ({ params }: { params: { cwd: string } }) =>
          Effect.succeed({
            isGitRepository: params.cwd === "/git",
            errorMessage: params.cwd === "/missing" ? "Missing directory" : null,
          }),
      } as GitWorkerRuntime["Service"]),
    );

it.effect("rejects substituted hosts, extra identity arguments, and withdrawn calls", () =>
  Effect.gen(function* () {
    const execute = yield* interpreter({ hostId: "remote" });
    assert.strictEqual((yield* execute(input)).isError, true);
    const local = yield* interpreter();
    assert.deepStrictEqual(
      (yield* local({ ...input, arguments: { threadId: "other" } })).structuredContent,
      { error: { code: "invalid_arguments" } },
    );
    let active = true;
    const revoked = yield* interpreter({
      afterRead: () => {
        active = false;
      },
    });
    assert.deepStrictEqual(
      (yield* revoked({ ...input, caller: { ...input.caller, isActive: () => active } }))
        .structuredContent,
      { error: { code: "call_withdrawn" } },
    );
  }),
);

it.effect(
  "distinguishes Git repositories, plain directories, and unavailable workspace inspection",
  () =>
    Effect.gen(function* () {
      const execute = yield* interpreter();
      const result = yield* execute({ ...input, name: "list_projects" });
      assert.deepStrictEqual(result.structuredContent, {
        projects: [
          {
            projectId: "git",
            name: "Git",
            path: "/git",
            hostId: "local",
            isGitRepository: true,
            gitStatus: "available",
          },
          {
            projectId: "plain",
            name: "Plain",
            path: "/plain",
            hostId: "local",
            isGitRepository: false,
            gitStatus: "available",
          },
          {
            projectId: "missing",
            name: "Missing",
            path: "/missing",
            hostId: "local",
            isGitRepository: null,
            gitStatus: "unavailable",
          },
          {
            projectId: "pages",
            name: "Pages",
            path: null,
            hostId: "local",
            isGitRepository: null,
            gitStatus: "no_workspace",
          },
        ],
      });
    }),
);

it.effect(
  "native capability reporting retains each backend and accepts only host-issued claims",
  () =>
    Effect.gen(function* () {
      const execute = yield* interpreter();
      for (const backend of ["claude", "opencode"] as const) {
        const issuer = createNativeAppToolClaimIssuer({
          backend,
          threadId: "thread",
          hostId: "local",
          generation: 1,
          capture: () => Effect.succeed(true),
        });
        issuer.beginTurn({
          threadId: "thread",
          turnId: "turn",
          rootThreadId: "thread",
          actorProjectId: "project",
          libraryId: "library",
          storeEpoch: "epoch",
          frozenAtMs: 1,
          readOnly: false,
          scope: "project",
          source: "project_turn",
        });
        const caller = issuer.claim()!;
        const capabilityCall = { ...input, caller, name: "get_app_capabilities" };
        const result = yield* execute(capabilityCall);
        assert.deepInclude(result.structuredContent, {
          backend,
          sessionContext: "authorized_session_history",
          workbenchControl: "unavailable",
          applicationToolLifetime: "foreground_without_background_tasks",
          backgroundApplicationTools: "unavailable",
        });
        const tools = result.structuredContent?.tools as string[];
        assert.include(tools, "query_content");
        assert.include(tools, "send_message_to_session");
        assert.notInclude(tools, "consume_usage_reset");
        assert.deepEqual(
          (yield* execute({ ...capabilityCall, name: "consume_usage_reset" })).structuredContent,
          { error: { code: "tool_unavailable" } },
        );
        assert.deepEqual(
          (yield* execute({ ...capabilityCall, caller: { ...caller } })).structuredContent,
          { error: { code: "authority_unavailable" } },
        );
        issuer.close();
        assert.deepEqual((yield* execute(capabilityCall)).structuredContent, {
          error: { code: "call_withdrawn" },
        });
      }
    }),
);
