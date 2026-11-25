import { describe, expect } from "vite-plus/test";
import { ChatSearch } from "../chat-search/ChatSearch";
import { LibraryModule } from "../library-application/LibraryModule";
import { GitHubSourceAdapter } from "../../host/sources/GitHubSourceAdapter";
import { InboxApplication } from "../../host/inbox-application/InboxApplication";
import { NodexEntryNotifications } from "../../host/NotificationIntents";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WorkApplication } from "../../host/work-application/WorkApplication";
import { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { CodexMainConversationInterrupt } from "../codex-application/CodexMainConversationInterrupt";
import { CodexQueuedFollowUps } from "../codex-application/CodexQueuedFollowUps";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import { CodexAttachments } from "../codex-application/CodexAttachments";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { CodexDelegatedMessages } from "../codex-application/CodexDelegatedMessages";
import { FileExportRuntime } from "../library-application/FileExportRuntime";
import { PluginNativeOperations } from "../codex-application/PluginNativeOperations";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import { SessionWaiter } from "./SessionWaiter";
import { ProjectSessionCommands } from "../project-application/ProjectSessionCommands";
import { SessionObservation } from "./SessionObservation";
import * as FileSystem from "effect/FileSystem";
import { CoreSessionAccess, CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { AutomationApplication } from "../../host/automation-application/AutomationApplication";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Project } from "../../shared/types";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import {
  type AppToolInvocation,
  make as makeAppToolInvocationInbox,
} from "./AppToolInvocationInbox";
import { make } from "./AppToolInterpreter";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { CodexAccount, CodexAccountInputError } from "../codex-application/CodexAccount";
import { WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";
import { ComposerCatalog } from "../codex-application/ComposerCatalog";
import { CodexTurnPresentation } from "../../host/TurnPresentation";
import { NodexAppToolAuthority, make as makeAppToolCaller } from "./NodexAppToolAuthority";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchObservation } from "./WorkbenchObservation";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import {
  createHostedAppToolCaller,
  captureAppToolAuthority,
  captureHostedAppToolAuthority,
  readHostedAppToolSessionContext,
} from "./AppToolCaller";
import { nativeQuestionTestLayers } from "./native-question-test-layers";
import { createStableOperationId } from "../core-runtime/operation-identity";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { make as makeAccountAppTools } from "./AccountAppTools";
import { it as itapptoolresult } from "vitest";
import { z } from "zod";
import { parseAppToolArguments, toolSuccess } from "./app-tool-result";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";

describe("AppToolInterpreter", () => {
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
        Effect.provide(nativeQuestionTestLayers),
        Effect.provideService(CodexThreadReadState, {} as never),
        Effect.provideService(CodexMainConversationInterrupt, {} as never),
        Effect.provideService(CodexQueuedFollowUps, {} as never),
        Effect.provideService(NodexAgentApplication, {} as never),
        Effect.provideService(TerminalSessions, {} as never),
        Effect.provideService(CodexAccount, {} as never),
        Effect.provideService(WorkspaceDependencyRuntime, {} as never),
        Effect.provideService(ComposerCatalog, {} as never),
        Effect.provideService(PluginNativeOperations, {} as never),
        Effect.provideService(CodexThreadDirectory, {} as never),
        Effect.provideService(CodexMainConversationResume, {} as never),
        Effect.provideService(CodexAttachments, {} as never),
        Effect.provideService(ExecutionHostRuntime, {} as never),
        Effect.provideService(CodexDelegatedMessages, {} as never),
        Effect.provideService(FileExportRuntime, {} as never),
        Effect.provideService(CodexGateway, {} as never),
        Effect.provideService(CodexNativeThreadLookup, {} as never),
        Effect.provideService(TemporaryAssets, {} as never),
        Effect.provideService(WorkApplication, {} as never),
      )
      .pipe(
        Effect.provideService(ChatSearch, {} as ChatSearch["Service"]),
        Effect.provideService(LibraryModule, {} as LibraryModule["Service"]),
        Effect.provideService(CodexTurnPresentation, {} as never),
        Effect.provideService(NodexAppToolAuthority, {} as never),
        Effect.provideService(WorkbenchAgentBridge, {} as never),
        Effect.provideService(WorkbenchObservation, {} as never),
        Effect.provideService(WorkbenchContentRouting, {} as never),
        Effect.provideService(CoreAuthority, {} as never),
        Effect.provideService(CodexThreadHandoffRuntime, {} as never),
        Effect.provideService(ProjectSessionCommands, {} as never),
        Effect.provideService(SessionObservation, {} as never),
      )
      .pipe(
        Effect.provideService(SessionWaiter, {} as never),
        Effect.provideService(AgentRuntimeApplication, {} as never),
        Effect.provideService(InboxApplication, {} as never),
        Effect.provideService(NodexEntryNotifications, {} as never),
        Effect.provideService(ApplicationSettings, {} as never),
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
      )
      .pipe(
        Effect.provideService(GitHubSourceAdapter, {} as never),
        Effect.provide(FileSystem.layerNoop({})),
        Effect.provideService(CoreSessionAccess, {} as never),
      );

  it.effect("rejects substituted hosts, extra identity arguments, and withdrawn calls", () =>
    Effect.gen(function* () {
      const execute = yield* interpreter({ hostId: "remote" });
      assert.strictEqual((yield* execute(input)).isError, true);
      const local = yield* interpreter();
      const malformed = yield* local({ ...input, arguments: { threadId: "other" } });
      assert.nestedPropertyVal(malformed.structuredContent, "error.code", "invalid_arguments");
      assert.nestedPropertyVal(
        malformed.structuredContent,
        "error.details.issues.0.path.0",
        "threadId",
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
        for (const backend of ["claudeAgent", "opencode"] as const) {
          let active = true;
          const authority = {
            threadId: "thread",
            turnId: "turn",
            rootThreadId: "thread",
            actorProjectId: "project",
            libraryId: "library",
            storeEpoch: "epoch",
            admittedAtMs: 1,
          };
          const caller = createHostedAppToolCaller({
            backend,
            authority,
            callId: "call",
            generation: 1,
            isActive: () => active,
            capture: Effect.succeed(authority),
          });
          const capabilityCall = { ...input, caller, name: "get_app_capabilities" };
          const result = yield* execute(capabilityCall);
          assert.deepInclude(result.structuredContent, {
            backend,
            sessionContext: "session_history",
            contentAccess: "profile_sql",
            workbenchControl: "unavailable",
            applicationToolLifetime: "native_connection",
            backgroundApplicationTools: "available",
          });
          const tools = result.structuredContent?.tools as string[];
          assert.include(tools, "query_content");
          assert.include(tools, "set_page_properties");
          assert.include(tools, "send_message_to_session");
          assert.include(tools, "session_question");
          assert.notInclude(tools, "consume_usage_reset");
          assert.deepEqual(
            (yield* execute({ ...capabilityCall, name: "consume_usage_reset" })).structuredContent,
            { error: { code: "tool_unavailable" } },
          );
          assert.deepEqual(
            (yield* execute({ ...capabilityCall, caller: { ...caller } })).structuredContent,
            { error: { code: "authority_unavailable" } },
          );
          active = false;
          assert.deepEqual((yield* execute(capabilityCall)).structuredContent, {
            error: { code: "call_withdrawn" },
          });
        }
      }),
  );
});

describe("AppToolOperation", () => {
  const make = makeAppToolOperation;
  describe("AppToolOperation", () => {
    const authority: NodexAgentTurnContext = {
      threadId: "thread",
      turnId: "turn",
      rootThreadId: "root",
      actorProjectId: null,
      libraryId: "library",
      storeEpoch: "epoch",
      admittedAtMs: 999,
    };
    const input: AppToolInvocation = {
      name: "send_message_to_session",
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
    it.effect(
      "binds opaque UUID keys to canonical arguments across Turns and reports collisions",
      () =>
        Effect.gen(function* () {
          const fixture = createAppToolAdmissionFixture(123);
          const admit = yield* make.pipe(Effect.provideService(CoreModules, fixture.core));
          const idempotencyKey = "06d6709c-45e7-4b37-8c26-74e9d64c5aa1";
          const first = yield* admit(input, authority, "profile", {
            idempotencyKey,
            prompt: "Continue",
            sessionId: "target",
          });
          const later = yield* admit(
            { ...input, caller: { ...input.caller, turnId: "later", callId: "retry" } },
            { ...authority, turnId: "later", admittedAtMs: 5000 },
            "profile",
            { sessionId: "target", prompt: "Continue", idempotencyKey },
          );
          assert.deepStrictEqual(later, first);
          assert.strictEqual(fixture.records.size, 1);
          assert.isTrue(first.success);
          if (!first.success) return;
          assert.strictEqual(first.acceptedAtMs, 123);
          assert.notStrictEqual(first.operationId, idempotencyKey);
          const changed = yield* admit(input, authority, "profile", {
            idempotencyKey,
            prompt: "Different",
            sessionId: "target",
          });
          assert.isFalse(changed.success);
          if (changed.success) return;
          assert.deepStrictEqual(changed.result.structuredContent, {
            error: {
              code: "idempotency_key_reused",
              details: { retryable: false, recovery: { kind: "use_new_idempotency_key" } },
            },
          });
        }),
    );
    it.effect("keeps omitted identities bound to the original call and host admission time", () =>
      Effect.gen(function* () {
        const fixture = createAppToolAdmissionFixture();
        const admit = yield* make.pipe(Effect.provideService(CoreModules, fixture.core));
        const first = yield* admit(input, authority, "profile", { prompt: "Continue" });
        assert.deepStrictEqual(first, {
          success: true,
          operationId: createStableOperationId("app.send_message_to_session", 999, [
            "profile",
            "thread",
            "turn",
            "call",
          ]),
          acceptedAtMs: 999,
          expiresAtMs: 999 + 7 * 24 * 60 * 60 * 1000,
        });
        assert.deepStrictEqual(
          yield* admit(input, authority, "profile", { prompt: "Continue" }),
          first,
        );
        const another = yield* admit(
          { ...input, caller: { ...input.caller, callId: "another" } },
          authority,
          "profile",
          { prompt: "Continue" },
        );
        assert.isTrue(another.success);
        if (!first.success || !another.success) return;
        assert.notStrictEqual(another.operationId, first.operationId);
        assert.strictEqual(fixture.records.size, 0);
      }),
    );
  });

  describe("AppToolInvocationInbox", () => {
    const make = makeAppToolInvocationInbox;
    const invocation: AppToolInvocation = {
      caller: {
        threadId: "thread",
        turnId: "turn",
        callId: "call",
        hostId: "local",
        generation: 1,
        isActive: () => true,
      },
      name: "context",
      arguments: {},
    };

    it.effect("returns the semantic result and prevents duplicate interpretation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* make;
          let executions = 0;
          yield* inbox.invocations.pipe(
            Stream.runForEach((ticket) =>
              Effect.gen(function* () {
                const operation = () =>
                  Effect.sync(() => {
                    executions += 1;
                    return { content: [{ type: "text" as const, text: "context" }] };
                  });
                yield* inbox.interpret(ticket, operation);
                yield* inbox.interpret(ticket, operation);
              }),
            ),
            Effect.forkChild,
          );
          assert.deepStrictEqual(yield* inbox.invoke(invocation), {
            content: [{ type: "text", text: "context" }],
          });
          assert.strictEqual(executions, 1);
        }),
      ),
    );

    it.effect("withdraws active semantic work when its caller is interrupted", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* make;
          const started = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();
          yield* inbox.invocations.pipe(
            Stream.runForEach((ticket) =>
              inbox.interpret(ticket, () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                ),
              ),
            ),
            Effect.forkChild,
          );
          const call = yield* inbox.invoke(invocation).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(call);
          yield* Deferred.await(stopped);
        }),
      ),
    );

    it.effect("settles a defective interpreter and continues serving later calls", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* make;
          let executions = 0;
          yield* inbox.invocations.pipe(
            Stream.runForEach((ticket) =>
              inbox.interpret(ticket, () =>
                Effect.sync(() => {
                  executions += 1;
                  if (executions === 1) throw new Error("unexpected implementation failure");
                  return { content: [{ type: "text" as const, text: "recovered" }] };
                }),
              ),
            ),
            Effect.forkChild,
          );
          const failed = yield* inbox.invoke(invocation);
          assert.strictEqual(failed.isError, true);
          assert.deepStrictEqual(failed.structuredContent, {
            error: { code: "tool_execution_failed" },
          });
          assert.deepStrictEqual((yield* inbox.invoke(invocation)).content, [
            { type: "text", text: "recovered" },
          ]);
        }),
      ),
    );
  });
});

describe("AppToolCaller", () => {
  const make = makeAppToolCaller;
  describe("AppToolCaller", () => {
    const authority: NodexAgentTurnContext = {
      threadId: "native",
      turnId: "turn:a",
      rootThreadId: "native",
      actorProjectId: "project",
      libraryId: "library",
      storeEpoch: "epoch",
      admittedAtMs: 1,
    };

    for (const backend of ["codex", "claude", "opencode", "acp"] as const) {
      it.effect(`${backend} Runtime callers require the original Host-issued object`, () =>
        Effect.gen(function* () {
          const frozen: NodexAgentTurnContext = {
            ...authority,
            threadId: "child",
            turnId: "run",
            rootThreadId: "root",
            runtime: { sessionId: "product-session", runtimeId: "engine", turnKind: "run" },
          };
          let active = true;
          const sessionContext = {
            sessionId: "product-session",
            projectId: "project",
            runtimeId: "engine",
            rootThreadId: "root",
            threadId: "child",
            runId: "run",
            cwd: "/worktree",
          };
          const caller = createHostedAppToolCaller({
            backend,
            authority: frozen,
            callId: "call",
            generation: 1,
            isActive: () => active,
            capture: Effect.succeed(frozen),
            sessionContext,
          });
          sessionContext.sessionId = "mutated-product-session";
          assert.equal(caller.threadId, "child");
          assert.equal(readHostedAppToolSessionContext(caller)?.sessionId, "product-session");
          assert.equal(readHostedAppToolSessionContext(caller)?.threadId, "child");
          assert.isTrue(Object.isFrozen(readHostedAppToolSessionContext(caller)));
          assert.isNull(readHostedAppToolSessionContext({ ...caller }));
          // A copied caller can reach only persisted native Turns, never a Runtime Session authority.
          const legacyReads: string[] = [];
          const legacy = {
            capture: (threadId: string) =>
              Effect.sync(() => {
                legacyReads.push(threadId);
                return null;
              }),
          };
          assert.deepEqual(yield* captureAppToolAuthority(caller, legacy), frozen);
          assert.deepEqual(legacyReads, []);
          assert.isNull(yield* captureHostedAppToolAuthority({ ...caller }));
          assert.isNull(yield* captureAppToolAuthority({ ...caller }, legacy));
          active = false;
          assert.isNull(yield* captureHostedAppToolAuthority(caller));
          assert.isNull(readHostedAppToolSessionContext(caller));
        }),
      );
    }

    it.effect(
      "withdrawn Runtime calls cannot retain authority across an awaited Core capture",
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let active = true;
          const caller = createHostedAppToolCaller({
            backend: "codex",
            authority,
            callId: "call",
            generation: 1,
            isActive: () => active,
            capture: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.as(authority),
            ),
          });
          const capture = yield* captureHostedAppToolAuthority(caller).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          active = false;
          yield* Deferred.succeed(resume, undefined);
          assert.isNull(yield* Fiber.join(capture));
        }).pipe(Effect.scoped),
    );
  });

  describe("NodexAppToolAuthority", () => {
    const authority: NodexAgentTurnContext = {
      threadId: "thread",
      turnId: "turn",
      rootThreadId: "thread",
      actorProjectId: "project",
      libraryId: "library",
      storeEpoch: "epoch",
      admittedAtMs: 1,
    };
    it.effect("binds current execution identity and rejects withdrawn execution", () =>
      Effect.gen(function* () {
        const owner = yield* make;
        const current = yield* owner.bind({ authority, isCurrent: Effect.succeed(true) });
        assert.deepEqual(current.authority, authority);
        const withdrawn = yield* owner.bind({ authority, isCurrent: Effect.succeed(false) });
        assert.isNull(withdrawn.authority);
      }),
    );
  });
});

describe("AccountAppTools", () => {
  const make = makeAccountAppTools;
  const authority: NodexAgentTurnContext = {
    threadId: "thread",
    turnId: "turn",
    rootThreadId: "thread",
    actorProjectId: "project",
    libraryId: "library",
    storeEpoch: "epoch",
    admittedAtMs: 1,
  };
  const input: AppToolInvocation = {
    name: "consume_usage_reset",
    arguments: { idempotencyKey: "exact-retry-key" },
    caller: {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      hostId: "local",
      generation: 1,
      isActive: () => true,
    },
  };
  it.effect(
    "preserves reset identity and private account data while refusing withdrawn native calls",
    () =>
      Effect.gen(function* () {
        let active = true;
        const call = { ...input, caller: { ...input.caller, isActive: () => active } };
        let uncertain = false;
        const calls: string[] = [];
        const execute = yield* make.pipe(
          Effect.provideService(CoreModules, createAppToolAdmissionFixture().core),
          Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
          Effect.provideService(CodexTurnAuthority, {
            capture: () => Effect.succeed(authority),
          } as unknown as CodexTurnAuthority["Service"]),
          Effect.provideService(CodexAccount, {
            readUsageLimits: Effect.succeed({
              ordinaryUsageAllowed: false,
              rateLimits: null,
              rateLimitsByLimitId: null,
              rateLimitResetCredits: null,
            }),
            consumeRateLimitResetCredit: (request: { idempotencyKey: string }) =>
              Effect.gen(function* () {
                calls.push(request.idempotencyKey);
                if (uncertain)
                  return yield* new CodexAccountInputError({ message: "response lost" });
                return {
                  outcome: "noCredit",
                  account: {
                    account: { type: "chatgpt", email: "private@example.com", planType: "plus" },
                    pendingLogin: { loginId: "private", authUrl: "private" },
                    requiresOpenAiAuth: false,
                  },
                };
              }),
          } as unknown as CodexAccount["Service"]),
        );
        assert.deepStrictEqual(
          (yield* execute({ ...call, name: "get_usage_limits", arguments: {} })).structuredContent,
          {
            ordinaryUsageAllowed: false,
            rateLimits: null,
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
          },
        );
        const first = yield* execute(call);
        const operationId = first.structuredContent?.operationId;
        assert.deepStrictEqual(first.structuredContent, {
          outcome: "noCredit",
          rateLimits: null,
          rateLimitResetCredits: null,
          operationId,
        });
        uncertain = true;
        assert.deepStrictEqual((yield* execute(call)).structuredContent, {
          error: {
            code: "reset_outcome_unavailable",
            details: { operationId },
          },
        });
        active = false;
        assert.deepStrictEqual((yield* execute(call)).structuredContent, {
          error: { code: "call_withdrawn" },
        });
        assert.deepStrictEqual(calls, [operationId, operationId]);
      }),
  );
});

describe("app-tool-result", () => {
  const it = itapptoolresult;
  describe("application tool argument parsing", () => {
    it("returns actionable nested paths and reasons in text and structured errors", () => {
      const parsed = parseAppToolArguments(sessionMessageSchema, {
        sessionId: "target",
        prompt: "Continue",
        attachments: [{ type: "library_file", fileId: 42 }],
        idempotencyKey: "x".repeat(129),
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.result.structuredContent).toMatchObject({
        error: {
          code: "invalid_arguments",
          details: {
            issues: [
              { path: ["attachments", 0, "fileId"], message: expect.any(String) },
              { path: ["idempotencyKey"], message: expect.any(String) },
            ],
          },
        },
      });
      const content = parsed.result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type !== "text") return;
      expect(JSON.parse(content.text)).toMatchObject({
        issues: [{ path: ["attachments", 0, "fileId"] }, { path: ["idempotencyKey"] }],
      });
    });

    it("accepts opaque UUID and whitespace keys unchanged, preserves omission, and reports object errors", () => {
      const schema = z.strictObject({ idempotencyKey: z.string().min(1).max(128).optional() });
      for (const key of ["06d6709c-45e7-4b37-8c26-74e9d64c5aa1", " retry / 任意 🦉 ", " "])
        expect(parseAppToolArguments(schema, { idempotencyKey: key })).toEqual({
          success: true,
          data: { idempotencyKey: key },
        });
      expect(parseAppToolArguments(schema, {})).toEqual({ success: true, data: {} });
      const invalid = parseAppToolArguments(sessionMessageSchema, {
        sessionId: "target",
        providerInstanceId: "codex",
      });
      expect(invalid.success).toBe(false);
      if (invalid.success) return;
      expect(invalid.result.structuredContent).toMatchObject({
        error: {
          details: {
            issues: expect.arrayContaining([
              { path: ["model"], message: "Choose the model the other Agent runs" },
            ]),
          },
        },
      });
    });
  });

  it("returns a complete failure instead of truncating an oversized result", () => {
    const result = toolSuccess({ rows: ["正文".repeat(150_000)] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: "result_too_large" } });
  });

  it("enforces a narrower tool budget without changing the successful payload", () => {
    const value = { text: "x".repeat(1000) };
    expect(toolSuccess(value, 500).isError).toBe(true);
    expect(toolSuccess(value, 3000).structuredContent).toEqual(value);
  });
});
