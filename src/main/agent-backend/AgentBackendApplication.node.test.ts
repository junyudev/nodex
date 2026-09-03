import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AcpConversationSnapshot } from "../../shared/acp-conversation";
import type { ProjectWorkspaceService } from "../project-application/ProjectWorkspace";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import {
  AcpBackendSessionManager,
  type AcpDeferredInitialPrompt,
  type AcpBackendSessionState,
  type AcpBackendSessionHandle,
  type OpenAcpBackendSessionInput,
} from "./acp/AcpBackendSessionManager";
import { emptyAcpConversationSnapshot } from "./acp/AcpConversationProjection";
import {
  make,
  projectAcpSessionConfigOptions,
  projectAcpSessionModes,
  resolveAcpPermissionPolicy,
} from "./AgentBackendApplication";

const binding = {
  kind: "acp" as const,
  agentDefinitionId: "claude-agent-acp" as const,
  instanceConfigId: "claude-local",
};

const thread = {
  threadId: "thread-1",
  projectId: "project-1",
  sessionId: "session-1",
  backendBinding: binding,
  cwd: "/workspace",
};

const project = {
  id: "project-1",
  lifecycle: "active",
  primaryWorkspaceRoot: "/workspace",
};

const firstSubmission = {
  launchId: "01991e60-b800-7000-8000-000000000011",
  clientUserMessageId: "01991e60-b800-7000-8000-000000000012",
} as const;

const makeHandleFor = (input?: {
  readonly threadId?: string;
  readonly prompt?: AcpBackendSessionHandle["prompt"];
}) =>
  Effect.gen(function* () {
    const threadId = input?.threadId ?? thread.threadId;
    const status = yield* SubscriptionRef.make<AcpBackendSessionState>({ kind: "idle" });
    const snapshot = yield* SubscriptionRef.make(
      emptyAcpConversationSnapshot({ threadId, sessionId: "protocol-session-1" }),
    );
    const deferredInitialPrompt = yield* Ref.make<AcpDeferredInitialPrompt | null>(null);
    return {
      threadId,
      agentDefinitionId: binding.agentDefinitionId,
      instanceConfigId: binding.instanceConfigId,
      sessionId: "protocol-session-1",
      capabilities: {
        prompt: {
          text: true,
          resourceLink: true,
          image: false,
          audio: false,
          embeddedContext: false,
        },
        session: {
          load: true,
          list: false,
          delete: false,
          resume: false,
          unstableFork: false,
          close: true,
          additionalDirectories: false,
        },
        authMethods: [],
      },
      modes: null,
      configOptions: [],
      status,
      snapshot,
      events: Stream.empty,
      authenticate: () => Effect.succeed({} as never),
      deferInitialPrompt: (prompt: AcpDeferredInitialPrompt) =>
        Ref.set(deferredInitialPrompt, prompt),
      takeDeferredInitialPrompt: Ref.getAndSet(deferredInitialPrompt, null),
      listSessions: Effect.succeed({ sessions: [] } as never),
      deleteSession: () => Effect.void,
      prompt: input?.prompt ?? (() => Effect.succeed({ stopReason: "end_turn" as const })),
      cancel: Effect.void,
      setMode: () => Effect.void,
      setConfigOption: () => Effect.succeed([]),
    } as unknown as AcpBackendSessionHandle;
  });

const makeHandle = makeHandleFor();

describe("AgentBackendApplication authority", () => {
  it.effect("maps every Project permission mode to the ACP approval policy", () =>
    Effect.sync(() => {
      expect(resolveAcpPermissionPolicy("auto")).toBe("ask");
      expect(resolveAcpPermissionPolicy("guardian-approvals")).toBe("approve-for-me");
      expect(resolveAcpPermissionPolicy("full-access")).toBe("approve-for-me");
      expect(resolveAcpPermissionPolicy("custom")).toBe("ask");
      expect(resolveAcpPermissionPolicy(null)).toBe("ask");
    }),
  );

  it.effect("projects protocol-owned session controls into canonical renderer values", () =>
    Effect.sync(() => {
      const modes = projectAcpSessionModes({
        currentModeId: "code",
        availableModes: [
          {
            id: "code",
            name: "Code",
            description: "Edit the workspace",
            _meta: { providerOnly: true },
          },
        ],
        _meta: { protocolOnly: true },
      });
      const configOptions = projectAcpSessionConfigOptions([
        {
          id: "model",
          name: "Model",
          description: "Choose a model",
          category: "model",
          type: "select",
          currentValue: "fast",
          options: [
            {
              group: "recommended",
              name: "Recommended",
              options: [
                {
                  value: "fast",
                  name: "Fast",
                  description: "Low latency",
                  _meta: { providerOnly: true },
                },
              ],
              _meta: { providerOnly: true },
            },
          ],
          _meta: { protocolOnly: true },
        },
      ]);

      expect(modes).toEqual({
        currentModeId: "code",
        availableModes: [{ id: "code", name: "Code", description: "Edit the workspace" }],
      });
      expect(configOptions).toEqual([
        {
          id: "model",
          name: "Model",
          description: "Choose a model",
          category: "model",
          type: "select",
          currentValue: "fast",
          options: [
            {
              group: "recommended",
              name: "Recommended",
              options: [{ value: "fast", name: "Fast", description: "Low latency" }],
            },
          ],
        },
      ]);
    }),
  );

  it.effect("restores the durable ACP protocol session from the Core-owned thread binding", () => {
    const open = vi.fn((input: OpenAcpBackendSessionInput) => {
      const sessionId = input.open && input.open.kind !== "new" ? input.open.sessionId : null;
      return makeHandle.pipe(
        Effect.map((handle) => ({ ...handle, sessionId: sessionId ?? handle.sessionId })),
      );
    });
    const bind = vi.fn(() => Effect.void);
    const workspace = {
      getThread: () => Effect.succeed(thread),
      getProject: () => Effect.succeed(project),
      readProjectPermissionMode: () => Effect.succeed("auto" as const),
      readProjectlessPermissionMode: Effect.succeed("auto" as const),
      readThreadBackendSession: () =>
        Effect.succeed({
          threadId: thread.threadId,
          backendBinding: binding,
          backendSessionId: "protocol-session-1",
          updatedAt: 1,
        }),
      bindThreadBackendSession: bind,
    } as unknown as ProjectWorkspaceService;
    const registry = AgentBackendRegistry.of({
      resolve: () =>
        Effect.succeed({
          kind: "acp",
          binding,
          displayName: "Claude Agent",
          definition: {} as never,
          instance: {} as never,
        }),
      resolveAcpInstance: () => Effect.die("not used"),
    });
    let liveHandle: AcpBackendSessionHandle | null = null;
    const manager = AcpBackendSessionManager.of({
      open: (input) =>
        open(input).pipe(Effect.tap((handle) => Effect.sync(() => (liveHandle = handle)))),
      get: () => Effect.succeed(liveHandle),
      observe: () => Effect.void,
      unobserve: () => Effect.void,
      close: () => Effect.void,
      changes: Stream.empty,
    });

    return make.pipe(
      Effect.flatMap((application) => application.openAcpSession({ threadId: thread.threadId })),
      Effect.provideService(AgentBackendRegistry, registry),
      Effect.provideService(AcpBackendSessionManager, manager),
      Effect.provideService(ProjectWorkspace, ProjectWorkspace.of(workspace)),
      Effect.map((presentation) => {
        expect(open).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: thread.threadId,
            workspaceRoot: "/workspace",
            permissionPolicy: "ask",
            open: { kind: "load", sessionId: "protocol-session-1" },
          }),
        );
        expect(bind).not.toHaveBeenCalled();
        expect(presentation.snapshot.sessionId).toBe("protocol-session-1");
      }),
    );
  });

  it.effect("keeps the durable Thread active until a cancelled prompt actually stops", () => {
    const updateThread = vi.fn(() => Effect.succeed(thread));
    const workspace = {
      updateThread,
    } as unknown as ProjectWorkspaceService;
    const registry = AgentBackendRegistry.of({
      resolve: () => Effect.die("not used"),
      resolveAcpInstance: () => Effect.die("not used"),
    });

    return makeHandle.pipe(
      Effect.tap((handle) =>
        SubscriptionRef.update(handle.snapshot, (current) => ({
          ...current,
          status: "running" as const,
          revision: current.revision + 1,
        })),
      ),
      Effect.flatMap((handle) => {
        const manager = AcpBackendSessionManager.of({
          open: () => Effect.die("not used"),
          get: () => Effect.succeed(handle),
          observe: () => Effect.void,
          unobserve: () => Effect.void,
          close: () => Effect.void,
          changes: Stream.empty,
        });
        return make.pipe(
          Effect.flatMap((application) => application.cancelAcpSession(thread.threadId)),
          Effect.provideService(AcpBackendSessionManager, manager),
        );
      }),
      Effect.provideService(AgentBackendRegistry, registry),
      Effect.provideService(ProjectWorkspace, ProjectWorkspace.of(workspace)),
      Effect.map((cancelled) => {
        expect(cancelled.status).toBe("running");
        expect(updateThread).not.toHaveBeenCalled();
      }),
    );
  });

  it.effect("clears durable active status when an in-flight prompt is interrupted", () =>
    Effect.gen(function* () {
      const becameActive = yield* Deferred.make<void>();
      const statusTypes: string[] = [];
      const workspace = {
        updateThread: (_threadId: string, patch: { status: { statusType: string } }) =>
          Effect.sync(() => {
            statusTypes.push(patch.status.statusType);
          }).pipe(
            Effect.andThen(
              patch.status.statusType === "active"
                ? Deferred.succeed(becameActive, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.as(thread),
          ),
      } as unknown as ProjectWorkspaceService;
      const registry = AgentBackendRegistry.of({
        resolve: () => Effect.die("not used"),
        resolveAcpInstance: () => Effect.die("not used"),
      });
      const handle = yield* makeHandleFor({ prompt: () => Effect.never });
      const manager = AcpBackendSessionManager.of({
        open: () => Effect.die("not used"),
        get: () => Effect.succeed(handle),
        observe: () => Effect.void,
        unobserve: () => Effect.void,
        close: () => Effect.void,
        changes: Stream.empty,
      });
      const application = yield* make.pipe(
        Effect.provideService(AgentBackendRegistry, registry),
        Effect.provideService(AcpBackendSessionManager, manager),
        Effect.provideService(ProjectWorkspace, ProjectWorkspace.of(workspace)),
      );

      const running = yield* application
        .promptAcpSession({ threadId: thread.threadId, prompt: "wait" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(becameActive);
      yield* Fiber.interrupt(running);

      expect(statusTypes).toEqual(["active", "idle"]);
    }),
  );

  it.effect(
    "returns a newly started Thread before its process-owned initial prompt completes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const promptStarted = yield* Deferred.make<void>();
          const releasePrompt = yield* Deferred.make<void>();
          const promptFinished = yield* Deferred.make<void>();
          let linkedThread: typeof thread | null = null;
          let liveHandle: AcpBackendSessionHandle | null = null;
          const updateThread = vi.fn(
            (threadId: string, patch: { status: { statusType: string } }) =>
              Effect.sync(() => ({
                ...linkedThread,
                threadId,
                statusType: patch.status.statusType,
              })),
          );
          const workspace = {
            getProjectSession: () =>
              Effect.succeed({
                id: "session-1",
                projectId: "project-1",
                thread: linkedThread,
              }),
            getProject: () =>
              Effect.succeed({
                ...project,
                sources: [{ root: "/workspace", order: 0 }],
              }),
            upsertProjectSessionThreadLink: (input: {
              readonly sessionId: string;
              readonly projectId: string;
              readonly threadId: string;
              readonly backendBinding: typeof binding;
              readonly cwd: string;
            }) =>
              Effect.sync(() => {
                linkedThread = {
                  threadId: input.threadId,
                  projectId: input.projectId,
                  sessionId: input.sessionId,
                  backendBinding: input.backendBinding,
                  cwd: input.cwd,
                };
                return linkedThread;
              }),
            getThread: (threadId: string) =>
              Effect.succeed(linkedThread?.threadId === threadId ? linkedThread : null),
            readProjectPermissionMode: () => Effect.succeed("auto" as const),
            readProjectlessPermissionMode: Effect.succeed("auto" as const),
            readThreadBackendSession: () => Effect.succeed(null),
            bindThreadBackendSession: () => Effect.void,
            updateThread,
          } as unknown as ProjectWorkspaceService;
          const registry = AgentBackendRegistry.of({
            resolve: () =>
              Effect.succeed({
                kind: "acp",
                binding,
                displayName: "Claude Agent",
                definition: {} as never,
                instance: {} as never,
              }),
            resolveAcpInstance: () =>
              Effect.succeed({
                kind: "acp",
                binding,
                displayName: "Claude Agent",
                definition: {} as never,
                instance: {} as never,
              }),
          });
          const manager = AcpBackendSessionManager.of({
            open: (input) =>
              makeHandleFor({
                threadId: input.threadId,
                prompt: () =>
                  Deferred.succeed(promptStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePrompt)),
                    Effect.ensuring(Deferred.succeed(promptFinished, undefined)),
                    Effect.as({ stopReason: "end_turn" as const }),
                  ),
              }).pipe(Effect.tap((handle) => Effect.sync(() => (liveHandle = handle)))),
            get: () => Effect.succeed(liveHandle),
            observe: () => Effect.void,
            unobserve: () => Effect.void,
            close: () => Effect.void,
            changes: Stream.empty,
          });
          const application = yield* make.pipe(
            Effect.provideService(AgentBackendRegistry, registry),
            Effect.provideService(AcpBackendSessionManager, manager),
            Effect.provideService(ProjectWorkspace, ProjectWorkspace.of(workspace)),
          );

          const start = yield* application
            .startAcpThread({
              sessionId: "session-1",
              instanceConfigId: binding.instanceConfigId,
              prompt: "Run a slow task",
              firstSubmission,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(promptStarted);
          yield* Effect.yieldNow;

          expect(start.pollUnsafe()).toBeDefined();
          expect(updateThread).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ status: { statusType: "active", activeFlags: [] } }),
          );

          yield* Deferred.succeed(releasePrompt, undefined);
          yield* Deferred.await(promptFinished);
          const result = yield* Fiber.join(start);
          expect(result.thread.threadId).toBeTruthy();
          expect(result.thread.sessionId).toBe("session-1");
        }),
      ),
  );

  it.effect(
    "submits an authentication-gated initial prompt exactly once after the session is bound",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let linkedThread: typeof thread | null = null;
          let protocolSessionId: string | null = null;
          let durableSession: {
            readonly threadId: string;
            readonly backendBinding: typeof binding;
            readonly backendSessionId: string;
            readonly updatedAt: number;
          } | null = null;
          const promptStarted = yield* Deferred.make<void>();
          const deferredInitialPrompt = yield* Ref.make<AcpDeferredInitialPrompt | null>(null);
          const status = yield* SubscriptionRef.make<AcpBackendSessionState>({
            kind: "authentication-required",
            error: {} as never,
          });
          const snapshot = yield* SubscriptionRef.make<AcpConversationSnapshot>({
            ...emptyAcpConversationSnapshot({
              threadId: "thread-pending",
              sessionId: "pending:thread-pending",
            }),
            status: "authentication-required" as const,
          });
          const prompt = vi.fn(() =>
            Deferred.succeed(promptStarted, undefined).pipe(
              Effect.as({ stopReason: "end_turn" as const }),
            ),
          );
          const handle = {
            get threadId() {
              return linkedThread?.threadId ?? "thread-pending";
            },
            agentDefinitionId: binding.agentDefinitionId,
            instanceConfigId: binding.instanceConfigId,
            get sessionId() {
              return protocolSessionId;
            },
            capabilities: {
              prompt: {
                text: true as const,
                resourceLink: true as const,
                image: false,
                audio: false,
                embeddedContext: false,
              },
              session: {
                load: true,
                list: false,
                delete: false,
                resume: false,
                unstableFork: false,
                close: true,
                additionalDirectories: false,
              },
              authMethods: [
                {
                  id: "claude-account",
                  name: "Claude account",
                  description: null,
                  kind: "agent" as const,
                },
              ],
            },
            modes: null,
            configOptions: [],
            status,
            snapshot,
            events: Stream.empty,
            authenticate: () =>
              Effect.sync(() => {
                protocolSessionId = "protocol-session-authenticated";
              }).pipe(
                Effect.andThen(
                  SubscriptionRef.update(snapshot, (current) => ({
                    ...current,
                    sessionId: "protocol-session-authenticated",
                    status: "idle" as const,
                    revision: current.revision + 1,
                  })),
                ),
                Effect.as({} as never),
              ),
            deferInitialPrompt: (value) => Ref.set(deferredInitialPrompt, value),
            takeDeferredInitialPrompt: Ref.getAndSet(deferredInitialPrompt, null),
            listSessions: Effect.succeed({ sessions: [] } as never),
            deleteSession: () => Effect.void,
            prompt,
            cancel: Effect.void,
            setMode: () => Effect.void,
            setConfigOption: () => Effect.succeed([]),
          } satisfies AcpBackendSessionHandle;
          const bindThreadBackendSession = vi.fn(
            (input: {
              readonly threadId: string;
              readonly backendBinding: typeof binding;
              readonly backendSessionId: string;
            }) =>
              Effect.sync(() => {
                durableSession = { ...input, updatedAt: 1 };
              }),
          );
          const workspace = {
            getProjectSession: () =>
              Effect.succeed({
                id: "session-1",
                projectId: "project-1",
                thread: linkedThread,
              }),
            getProject: () =>
              Effect.succeed({ ...project, sources: [{ root: "/workspace", order: 0 }] }),
            upsertProjectSessionThreadLink: (input: {
              readonly sessionId: string;
              readonly projectId: string;
              readonly threadId: string;
              readonly backendBinding: typeof binding;
              readonly cwd: string;
            }) =>
              Effect.sync(() => {
                linkedThread = {
                  threadId: input.threadId,
                  projectId: input.projectId,
                  sessionId: input.sessionId,
                  backendBinding: input.backendBinding,
                  cwd: input.cwd,
                };
                return linkedThread;
              }),
            getThread: (threadId: string) =>
              Effect.succeed(linkedThread?.threadId === threadId ? linkedThread : null),
            readProjectPermissionMode: () => Effect.succeed("auto" as const),
            readProjectlessPermissionMode: Effect.succeed("auto" as const),
            readThreadBackendSession: () => Effect.succeed(durableSession),
            bindThreadBackendSession,
            updateThread: () => Effect.succeed(linkedThread ?? thread),
          } as unknown as ProjectWorkspaceService;
          const resolution = {
            kind: "acp" as const,
            binding,
            displayName: "Claude Agent",
            definition: {} as never,
            instance: {} as never,
          };
          const application = yield* make.pipe(
            Effect.provideService(
              AgentBackendRegistry,
              AgentBackendRegistry.of({
                resolve: () => Effect.succeed(resolution),
                resolveAcpInstance: () => Effect.succeed(resolution),
              }),
            ),
            Effect.provideService(
              AcpBackendSessionManager,
              AcpBackendSessionManager.of({
                open: (input) =>
                  SubscriptionRef.update(snapshot, (current) => ({
                    ...current,
                    threadId: input.threadId,
                    sessionId: `pending:${input.threadId}`,
                  })).pipe(Effect.as(handle)),
                get: () => Effect.succeed(handle),
                observe: () => Effect.void,
                unobserve: () => Effect.void,
                close: () => Effect.void,
                changes: Stream.empty,
              }),
            ),
            Effect.provideService(ProjectWorkspace, ProjectWorkspace.of(workspace)),
          );

          const started = yield* application.startAcpThread({
            sessionId: "session-1",
            instanceConfigId: binding.instanceConfigId,
            prompt: "Create the requested file",
            firstSubmission,
          });
          expect(started.presentation.snapshot.status).toBe("authentication-required");
          expect(prompt).not.toHaveBeenCalled();

          yield* application.authenticateAcpSession({
            threadId: started.thread.threadId,
            methodId: "claude-account",
          });
          yield* Deferred.await(promptStarted);
          expect(bindThreadBackendSession).toHaveBeenCalledTimes(1);
          expect(prompt).toHaveBeenCalledTimes(1);
          expect(prompt).toHaveBeenCalledWith(
            [{ type: "text", text: "Create the requested file" }],
            {
              clientUserMessageId: firstSubmission.clientUserMessageId,
            },
          );

          yield* application.authenticateAcpSession({
            threadId: started.thread.threadId,
            methodId: "claude-account",
          });
          yield* Effect.yieldNow;
          expect(prompt).toHaveBeenCalledTimes(1);
        }),
      ),
  );
});
