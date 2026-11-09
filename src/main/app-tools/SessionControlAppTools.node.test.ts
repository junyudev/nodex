import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import * as Clock from "effect/Clock";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import { CodexMainConversationInterrupt } from "../codex-application/CodexMainConversationInterrupt";
import { CodexQueuedFollowUps } from "../codex-application/CodexQueuedFollowUps";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { createHostedAppToolCaller } from "./AppToolCaller";
import { makeControlsWithCapture as makeWithCapture } from "./NativeSessionTools";
import { denied } from "./SessionControlAuthority";

const errorCode = (result: CallToolResult) =>
  (result.structuredContent?.error as { code?: string } | undefined)?.code;

const fixture = Effect.gen(function* () {
  const authority: NodexAgentTurnContext = {
    threadId: "caller-child",
    turnId: "run",
    rootThreadId: "caller-root",
    actorProjectId: "caller-project",
    libraryId: "library",
    storeEpoch: "epoch",
    admittedAtMs: yield* Clock.currentTimeMillis,
    runtime: { sessionId: "caller", runtimeId: "engine", turnKind: "run" },
  };
  let active = true;
  let authorized = true;
  let callerBackend: "runtime" | "native" = "runtime";
  let backend: "runtime" | "native" | "draft" = "runtime";
  let hostId = "remote";
  let archived = false;
  let sourceMode = "full-access";
  let sourcePlan = false;
  let targetPlan = false;
  let running = true;
  const calls: Array<{ name: string; input: unknown }> = [];
  const receipts = new Map<string, { fingerprint: string; resultJson: string | null }>();
  const record = (name: string, input: unknown) => calls.push({ name, input });
  const makeCaller = (turnId = "run") =>
    createHostedAppToolCaller({
      backend: "claude",
      authority: { ...authority, turnId },
      callId: turnId,
      generation: 1,
      isActive: () => active,
      capture: Effect.succeed({ ...authority, turnId }),
      sessionContext: {
        sessionId: "caller",
        projectId: "caller-project",
        runtimeId: "engine",
        rootThreadId: "caller-root",
        threadId: "caller-child",
        runId: turnId,
        cwd: "/repo",
      },
    });
  let caller = makeCaller();
  const nativeCaller = {
    threadId: "caller-native",
    turnId: "turn",
    callId: "native-call",
    hostId: "local",
    generation: 1,
    isActive: () => active,
  };
  const execute = yield* makeWithCapture((calling) =>
    Effect.sync(() => (authorized ? { ...authority, turnId: calling.turnId } : null)),
  ).pipe(
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Effect.provideService(CoreModules, {
      workspace: {
        admitToolOperation: createAppToolAdmissionFixture(authority.admittedAtMs)
          .admitToolOperation,
        read: (input: { session_id: string; provenance: unknown }) =>
          Effect.gen(function* () {
            assert.isNotNull(yield* CoreApplicationAgent);
            const isCaller = input.session_id === "caller";
            record("authorize", input);
            return {
              value: {
                kind: "agent_session",
                session: {
                  id: input.session_id,
                  project_id: isCaller ? "caller-project" : "other-project",
                  archived: !isCaller && archived,
                  execution_ref: (isCaller ? callerBackend === "runtime" : backend === "runtime")
                    ? { runtime_id: "engine", thread_id: isCaller ? "caller-root" : "target-root" }
                    : null,
                },
                thread: (isCaller ? callerBackend === "native" : backend === "native")
                  ? {
                      thread_id: isCaller ? "caller-native" : "target-native",
                      execution_host_id: isCaller ? "local" : hostId,
                      backend_binding: { kind: "codex" },
                    }
                  : null,
              },
            };
          }),
      },
    } as never),
    Effect.provideService(ProjectWorkspace, {
      getThread: () =>
        Effect.succeed({
          sessionId: "caller",
          executionHostId: "local",
          projectId: "caller-project",
          cwd: "/repo",
        }),
      getProjectSession: (id: string) =>
        Effect.sync(() => ({
          id,
          archived: id !== "caller" && archived,
          thread: {
            threadId: id === "caller" ? "caller-native" : "target-native",
            executionHostId: id === "caller" ? "local" : hostId,
            backendBinding: { kind: "codex" },
          },
        })),
      setProjectSessionReminder: (input: {
        payload: { sessionId: string; remindAt: string | null };
      }) =>
        Effect.sync(() => {
          record("core-reminder", input);
          return {
            value: { remindAt: input.payload.remindAt },
            apply: { receipt: "core-receipt" },
          };
        }),
      markProjectSessionUnread: (input: { payload: { sessionId: string; unread: boolean } }) =>
        Effect.sync(() => {
          record("core-unread", input);
          return { value: { unread: input.payload.unread }, apply: { receipt: "core-receipt" } };
        }),
    } as never),
    Effect.provideService(CodexThreadDirectory, {
      resolve: ({ threadId }: { threadId: string }) =>
        Effect.sync(() => ({
          canonical: {
            hostId: threadId === "caller-native" ? "local" : hostId,
            currentPermissions: {
              sandboxPolicy: { type: "dangerFullAccess" },
              approvalPolicy: "never",
              approvalsReviewer: "user",
            },
            latestThreadSettings: {
              model: "model",
              collaborationMode: {
                mode:
                  threadId === "caller-native"
                    ? sourcePlan
                      ? "plan"
                      : "default"
                    : targetPlan
                      ? "plan"
                      : "default",
              },
              approvalPolicy: "never",
              sandboxPolicy: { type: "dangerFullAccess" },
            },
          },
        })),
    } as never),
    Effect.provideService(CodexThreadReadState, {
      set: (input: unknown) =>
        Effect.sync(() => {
          record("native-unread", input);
          return true;
        }),
    } as never),
    Effect.provideService(CodexMainConversationManagers, {
      get: () =>
        Effect.succeed({
          generation: 1,
          assertCurrent: () => {},
          stream: { getRole: () => ({ role: "owner" }) },
        }),
    } as never),
    Effect.provideService(CodexMainConversationResume, {} as never),
    Effect.provideService(CodexMainConversationInterrupt, {
      interrupt: (host: string, threadId: string, mode: string) =>
        Effect.sync(() => {
          record("native-stop", { host, threadId, mode });
          const result = { interruptedTurnId: running ? "turn" : null };
          running = false;
          return result;
        }),
    } as never),
    Effect.provideService(CodexQueuedFollowUps, {
      controlAsOwner: (_host: string, _threadId: string, input: unknown) =>
        Effect.sync(() => {
          record("native-queue", input);
          return { sequence: 1 };
        }),
    } as never),
    Effect.provideService(CodexTurnCommands, {} as never),
    Effect.provideService(AgentRuntimeApplication, {
      inspect: (input: { sessionId: string; threadId?: string }) =>
        Effect.gen(function* () {
          if (input.threadId === "unrelated") return yield* denied("forbidden");
          return {
            sessionId: input.sessionId,
            threadId:
              input.threadId ?? (input.sessionId === "caller" ? "caller-root" : "target-root"),
            thread: {
              runtimeMode: input.sessionId === "caller" ? sourceMode : "full-access",
              interactionMode: (input.sessionId === "caller" ? sourcePlan : targetPlan)
                ? "plan"
                : "default",
              modelSelection: { instanceId: "claude", model: "model" },
            },
          };
        }),
      sessionControlReceipt: (input: {
        operationId: string;
        fingerprint: string;
        resultJson?: string;
      }) =>
        Effect.gen(function* () {
          const previous = receipts.get(input.operationId);
          if (previous && previous.fingerprint !== input.fingerprint)
            return yield* denied("operation_conflict");
          if (input.resultJson !== undefined) {
            receipts.set(input.operationId, {
              fingerprint: input.fingerprint,
              resultJson: input.resultJson,
            });
            return { admitted: false, resultJson: input.resultJson };
          }
          if (previous) return { admitted: false, resultJson: previous.resultJson };
          receipts.set(input.operationId, { fingerprint: input.fingerprint, resultJson: null });
          return { admitted: true, resultJson: null };
        }),
      stopSession: (input: unknown) =>
        Effect.sync(() => {
          record("runtime-stop", input);
          const stopped = running;
          running = false;
          return { threadId: "target-root", stopped };
        }),
      controlSessionQueue: (input: unknown) =>
        Effect.sync(() => {
          record("runtime-queue", input);
          return { sequence: 1 };
        }),
    } as never),
  );
  return {
    calls,
    receipts,
    nextTurn: () => {
      caller = makeCaller("later-turn");
    },
    execute: (name: string, args: Record<string, unknown>) =>
      execute({
        caller: callerBackend === "runtime" ? caller : nativeCaller,
        name,
        arguments: args,
      }),
    setBackend: (next: typeof backend) => {
      backend = next;
    },
    setHost: (next: string) => {
      hostId = next;
    },
    setArchived: () => {
      archived = true;
    },
    setCallerBackend: () => {
      callerBackend = "native";
    },
    setSourceMode: (next: string) => {
      sourceMode = next;
    },
    setPlan: (source: boolean, target = false) => {
      sourcePlan = source;
      targetPlan = target;
    },
    withdraw: () => {
      active = false;
    },
    deny: () => {
      authorized = false;
    },
    idle: () => {
      running = false;
    },
  };
});

it.effect.each(["runtime", "native"] as const)(
  "stops %s work once across retries, preserving the stopped result",
  (backend) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setBackend(backend);
      const args = {
        sessionId: "other-project-session",
        reason: "User cancelled the task",
        idempotencyKey: "stop",
      };
      const result = yield* f.execute("stop_session", args);
      assert.deepEqual(result.structuredContent, {
        operationId: result.structuredContent?.operationId,
        sessionId: args.sessionId,
        threadId: backend === "runtime" ? "target-root" : "target-native",
        status: "stop_requested",
      });
      f.nextTurn();
      assert.deepEqual(yield* f.execute("stop_session", args), result);
      const calls = f.calls.filter((call) => call.name === `${backend}-stop`);
      assert.lengthOf(calls, 1);
      if (backend === "runtime")
        assert.equal(
          (calls[0]!.input as { reason: string }).reason,
          "Stopped by another agent: User cancelled the task",
        );
    }),
);

it.effect(
  "native callers can stop Runtime Sessions and local native Stop stays with its owner",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setCallerBackend();
      assert.isNotTrue((yield* f.execute("stop_session", { sessionId: "target" })).isError);
      f.setBackend("native");
      f.setHost("local");
      assert.isNotTrue(
        (yield* f.execute("stop_session", {
          sessionId: "target",
          idempotencyKey: "local",
        })).isError,
      );
      assert.lengthOf(
        f.calls.filter((call) => call.name === "native-stop"),
        1,
      );
    }),
);

it.effect.each(["runtime", "native", "draft"] as const)(
  "reports idle %s Sessions without creating execution",
  (backend) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setBackend(backend);
      f.idle();
      const result = yield* f.execute("stop_session", { sessionId: "target" });
      assert.equal(result.structuredContent?.status, "idle");
    }),
);

it.effect("rejects the calling Session, including its selected Runtime child", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const execution of [undefined, { threadId: "caller-child" }]) {
      const result = yield* f.execute("stop_session", {
        sessionId: "caller",
        ...(execution ? { execution } : {}),
      });
      assert.equal(errorCode(result), "cannot_stop_calling_session");
    }
    assert.isEmpty(f.calls);
  }),
);

it.effect.each(["stop_session", "session_queue"])(
  "enforces live authority, archive state and permission ceilings for %s",
  (name) =>
    Effect.gen(function* () {
      const args =
        name === "stop_session" ? { sessionId: "target" } : { sessionId: "target", action: "list" };
      const mode = yield* fixture;
      mode.setSourceMode("approval-required");
      assert.equal(errorCode(yield* mode.execute(name, args)), "runtime_mode_escalation_denied");
      const plan = yield* fixture;
      plan.setPlan(true);
      assert.equal(
        errorCode(yield* plan.execute(name, args)),
        "interaction_mode_escalation_denied",
      );
      const archived = yield* fixture;
      archived.setArchived();
      assert.equal(errorCode(yield* archived.execute(name, args)), "session_unavailable");
      const unauthorized = yield* fixture;
      unauthorized.deny();
      assert.equal(errorCode(yield* unauthorized.execute(name, args)), "authority_unavailable");
      const withdrawn = yield* fixture;
      withdrawn.withdraw();
      assert.equal(errorCode(yield* withdrawn.execute(name, args)), "call_withdrawn");
    }),
);

it.effect("uses the sidebar's Core and identity read-state paths, with exact retry receipts", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const args = { unread: true, idempotencyKey: "unread" };
    const result = yield* f.execute("set_session_unread", args);
    assert.equal(result.structuredContent?.sessionId, "caller");
    assert.deepEqual(yield* f.execute("set_session_unread", args), result);
    assert.lengthOf(
      f.calls.filter((call) => call.name === "core-unread"),
      1,
    );
    f.setBackend("native");
    yield* f.execute("set_session_unread", {
      sessionId: "target",
      unread: false,
      idempotencyKey: "read-native",
    });
    assert.deepEqual(f.calls.find((call) => call.name === "native-unread")?.input, {
      threadId: "target-native",
      hasUnreadTurn: false,
    });
    f.setBackend("draft");
    yield* f.execute("set_session_unread", {
      sessionId: "target",
      unread: true,
      idempotencyKey: "draft-unread",
    });
    assert.lengthOf(
      f.calls.filter((call) => call.name === "core-unread"),
      2,
    );
  }),
);

it.effect.each(["runtime", "native"] as const)(
  "routes %s queue actions and fences retries and unrelated children",
  (backend) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setBackend(backend);
      for (const action of ["list", "read", "edit", "remove", "reorder", "steer"]) {
        const args = {
          sessionId: "target",
          action,
          ...(action === "list" ? {} : { queuedId: "queued" }),
          ...(action === "edit" ? { text: "replacement" } : {}),
          ...(action === "reorder" ? { beforeId: null } : {}),
          ...(["list", "read"].includes(action) ? {} : { idempotencyKey: action }),
        };
        const result = yield* f.execute("session_queue", args);
        assert.isNotTrue(result.isError);
        if (!["list", "read"].includes(action))
          assert.deepEqual(yield* f.execute("session_queue", args), result);
      }
      assert.lengthOf(
        f.calls.filter((call) => call.name === `${backend}-queue`),
        6,
      );
      if (backend === "runtime")
        assert.equal(
          errorCode(
            yield* f.execute("session_queue", {
              action: "list",
              sessionId: "target",
              execution: { threadId: "unrelated" },
            }),
          ),
          "forbidden",
        );
    }),
);

it.effect("returns unsupported for unavailable queues and refuses changed retry arguments", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setBackend("native");
    f.setHost("local");
    assert.equal(
      errorCode(yield* f.execute("session_queue", { sessionId: "target", action: "list" })),
      "unsupported",
    );
    const args = { sessionId: "target", idempotencyKey: "same" };
    yield* f.execute("stop_session", args);
    assert.equal(
      errorCode(yield* f.execute("stop_session", { ...args, reason: "changed" })),
      "idempotency_key_reused",
    );
  }),
);

it.effect("carries the admission ceiling to Runtime queue and Stop controls", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.execute("session_queue", {
      sessionId: "target",
      action: "edit",
      queuedId: "queued",
      text: "replacement",
    });
    yield* f.execute("stop_session", { sessionId: "target" });
    for (const name of ["runtime-queue", "runtime-stop"]) {
      const input = f.calls.find((call) => call.name === name)?.input as { modeLimit?: unknown };
      assert.deepEqual(input.modeLimit, { runtimeMode: "full-access", interactionMode: "default" });
    }
  }),
);

it.effect("sets, clears and exactly replays reminders for Runtime, native and draft Sessions", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const backend of ["runtime", "native", "draft"] as const) {
      f.setBackend(backend);
      for (const remindAt of ["2026-11-02T09:00:00.000Z", null]) {
        const args = { sessionId: "target", remindAt, idempotencyKey: `${backend}-${remindAt}` };
        const first = yield* f.execute("set_session_reminder", args);
        assert.equal(first.structuredContent?.remindAt, remindAt);
        f.nextTurn();
        assert.deepEqual(yield* f.execute("set_session_reminder", args), first);
      }
    }
    assert.lengthOf(
      f.calls.filter((call) => call.name === "core-reminder"),
      6,
    );
    assert.lengthOf(
      f.calls.filter((call) => call.name === "native-unread" || call.name === "core-unread"),
      0,
    );
  }),
);
