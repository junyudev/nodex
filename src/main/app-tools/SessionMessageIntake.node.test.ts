import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexAttachments } from "../codex-application/CodexAttachments";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import { CodexDelegatedMessages } from "../codex-application/CodexDelegatedMessages";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { FileExportRuntime } from "../library-application/FileExportRuntime";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { make, type SessionMessageIntakeInput } from "./SessionMessageIntake";

const fixture = (
  options: {
    readonly draft?: boolean;
    readonly runtime?: boolean;
    readonly replay?: boolean;
    readonly nativeReplay?: boolean;
    readonly resume?: boolean;
    readonly restricted?: boolean;
    readonly restrictedNative?: boolean;
    readonly importedPlan?: boolean;
  } = {},
) => {
  let adopted = options.runtime ?? false;
  const calls: Array<{ name: string; input: unknown }> = [];
  const capture = (name: string, result: unknown) => (input: unknown) =>
    Effect.sync(() => {
      calls.push({ name, input });
      return result;
    });
  const makeIntake = make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(CodexAttachments, {} as never),
        Layer.succeed(ExecutionHostRuntime, {} as never),
        Layer.succeed(CoreModules, {
          workspace: {
            read: ({ session_id }: { session_id: string }) =>
              Effect.succeed({
                value: {
                  kind: "agent_session",
                  session: {
                    id: session_id,
                    project_id: "project",
                    display_title: "Preserved title",
                    archived: false,
                    execution_ref:
                      session_id === "caller" || adopted
                        ? {
                            runtime_id: "runtime",
                            thread_id: session_id === "caller" ? "caller-thread" : "adopted-thread",
                          }
                        : null,
                  },
                  ...(!options.draft && session_id === "target" && !adopted
                    ? {
                        thread: {
                          thread_id: "native-thread",
                          execution_host_id: "local",
                          status: { status_type: "idle" },
                        },
                      }
                    : {}),
                },
              }),
          },
          library: {
            read: capture("file-read", {
              value: {
                kind: "file_presentation",
                value: {
                  version: 3,
                  default_name: "evidence.txt",
                  mime_type: "text/plain",
                  byte_length: 7,
                },
              },
            }),
          },
        } as never),
        Layer.succeed(ProjectWorkspace, {
          getProjectSession: () =>
            Effect.succeed({
              id: "target",
              archived: false,
              executionRef: null,
              thread: {
                threadId: "native-thread",
                executionHostId: "local",
                backendBinding: { kind: "codex" },
              },
            }),
        } as never),
        Layer.succeed(CodexThreadDirectory, {
          resolve: () =>
            Effect.succeed({
              canonical: {
                hostId: "local",
                currentPermissions: {
                  sandboxPolicy: options.restrictedNative
                    ? { type: "readOnly", networkAccess: false }
                    : { type: "dangerFullAccess" },
                  approvalPolicy: options.restrictedNative ? "on-request" : "never",
                  approvalsReviewer: "user",
                },
                latestModel: "gpt-test",
                latestCollaborationMode: { mode: "plan" },
                latestThreadSettings: {
                  model: "gpt-test",
                  collaborationMode: { mode: "plan" },
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "dangerFullAccess" },
                },
              },
            }),
        } as never),
        Layer.succeed(CodexMainConversationResume, {
          resume: () => Effect.succeed({ status: "ready" }),
        } as never),
        Layer.succeed(CodexDelegatedMessages, { send: capture("native-send", {}) } as never),
        Layer.succeed(CodexGateway, { localHostId: "local" } as never),
        Layer.succeed(CodexNativeThreadLookup, {} as never),
        Layer.succeed(TemporaryAssets, {} as never),
        Layer.succeed(FileExportRuntime, {
          materialize: capture("materialize", "/authorized/evidence.txt"),
        } as never),
        Layer.succeed(AgentRuntimeApplication, {
          nativeMessageReceipt: ({ messageId }: { messageId: string }) =>
            options.nativeReplay
              ? Effect.sync(() => {
                  calls.push({ name: "native-replay", input: messageId });
                  return {
                    admitted: false,
                    phase: "confirmed",
                    attemptId: "original-attempt",
                    sessionId: "target",
                    hostId: "original-remote",
                    threadId: "original-native",
                    result: {
                      messageId,
                      runId: "original-run",
                      status: "completed",
                      delivery: "queued",
                    },
                  };
                })
              : Effect.succeed(null),
          inspect: ({ sessionId }: { sessionId: string }) =>
            options.replay || (options.resume && sessionId === "target")
              ? Effect.die("Replay must not inspect current execution settings")
              : Effect.succeed({
                  sessionId,
                  threadId: sessionId === "caller" ? "caller-thread" : "adopted-thread",
                  thread: {
                    runtimeMode:
                      sessionId === "caller" && options.restricted
                        ? "approval-required"
                        : "full-access",
                    interactionMode:
                      sessionId === "target" && options.importedPlan === false ? "default" : "plan",
                    modelSelection: { instanceId: "codex", model: "gpt-test" },
                  },
                }),
          resumeMessageLaunch: options.resume
            ? capture("resume", {
                sessionId: "target",
                threadId: "adopted-thread",
                messageId: "staged-message",
                runId: "first-run",
                status: "queued",
                delivery: "started",
              })
            : () => Effect.succeed(null),
          replayMessage: capture(
            "replay",
            options.replay
              ? {
                  sessionId: "target",
                  threadId: "adopted-thread",
                  messageId: "accepted-message",
                  runId: "accepted-run",
                  status: "completed",
                  delivery: "queued",
                }
              : null,
          ),
          adoptNativeSession: (input: unknown) =>
            Effect.sync(() => {
              calls.push({ name: "adopt", input });
              adopted = true;
              return { sessionId: "target", threadId: "adopted-thread", projectId: "project" };
            }),
          sendMessage: capture("runtime-send", {
            sessionId: "target",
            threadId: "adopted-thread",
            messageId: "message",
            runId: "run",
            status: "queued",
            delivery: "queued",
          }),
          launch: capture("launch", {
            sessionId: "target",
            threadId: "draft-thread",
            projectId: "project",
          }),
          execution: () => Effect.succeed({ runId: "draft-run", status: "queued" }),
        } as never),
      ),
    ),
    Effect.map((intake) => ({
      send: (request: SessionMessageIntakeInput) =>
        intake.send(request).pipe(
          Effect.provideService(CoreApplicationAgent, {
            authority: { actor_project_id: "project" },
          } as never),
        ),
    })),
  );
  return { makeIntake, calls };
};
const input = (attachments = false) => ({
  request: sessionMessageSchema.parse({
    sessionId: "target",
    ...(attachments
      ? { attachments: [{ type: "library_file", fileId: "file" }] }
      : { prompt: "Continue" }),
    mode: "queue",
  }),
  caller: { sessionId: "caller" },
  operationId: createStableOperationId("app.send_message_to_session", 123, ["fixture"]),
  sourceThreadId: "caller-thread",
  sourceRunId: "caller-run",
});

it.effect(
  "adopts a local Native Session once before sending through its canonical Runtime binding",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const intake = yield* f.makeIntake;
      const result = yield* intake.send(input());
      assert.equal(result.delivery, "queued");
      assert.deepEqual(
        f.calls
          .filter((call) => ["adopt", "runtime-send", "native-send"].includes(call.name))
          .map((call) => call.name),
        ["adopt", "runtime-send"],
      );
      const sent = f.calls.find((call) => call.name === "runtime-send")!.input as {
        sessionId: string;
        threadId: string;
        mode: string;
        senderRunId: string;
      };
      assert.deepEqual(
        { sessionId: sent.sessionId, threadId: sent.threadId },
        { sessionId: "target", threadId: "adopted-thread" },
      );
      assert.equal(sent.mode, "queue");
      assert.equal(sent.senderRunId, "caller-run");
    }),
);

it.effect("rejects the Runtime permission ceiling before a Native binding can migrate", () =>
  Effect.gen(function* () {
    const f = fixture({ restricted: true, restrictedNative: true });
    const intake = yield* f.makeIntake;
    const result = yield* intake.send(input()).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(f.calls.length, 0);
  }),
);

it.effect("rejects a strict steer before importing a local Native Session", () =>
  Effect.gen(function* () {
    const f = fixture();
    const intake = yield* f.makeIntake;
    const request = input();
    const result = yield* intake
      .send({ ...request, request: { ...request.request, mode: "steer" } })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(f.calls.length, 0);
  }),
);

it.effect("rechecks the imported Plan settings before sending", () =>
  Effect.gen(function* () {
    const f = fixture({ importedPlan: false });
    const intake = yield* f.makeIntake;
    const result = yield* intake.send(input()).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(f.calls.filter((call) => call.name === "adopt").length, 1);
    assert.equal(f.calls.filter((call) => call.name === "runtime-send").length, 0);
  }),
);

it.effect("starts an attachment-only draft in place with the authorized immutable resource", () =>
  Effect.gen(function* () {
    const f = fixture({ draft: true });
    const intake = yield* f.makeIntake;
    yield* intake.send(input(true));
    const launched = f.calls.find((call) => call.name === "launch")!.input as {
      sessionId: string;
      message: { text: string };
      resources: unknown;
    };
    assert.equal(launched.sessionId, "target");
    assert.equal(launched.message.text, "");
    assert.deepEqual(launched.resources, [
      {
        name: "evidence.txt",
        mimeType: "text/plain",
        sizeBytes: 7,
        source: "/authorized/evidence.txt",
      },
    ]);
    assert.equal(f.calls.filter((call) => call.name === "materialize").length, 1);
    assert.equal(f.calls.filter((call) => call.name === "file-read").length, 2);
  }),
);

it.effect(
  "replays an accepted message before current mode checks or unavailable attachment resolution",
  () =>
    Effect.gen(function* () {
      const f = fixture({ runtime: true, replay: true, importedPlan: false });
      const intake = yield* f.makeIntake;
      const result = yield* intake.send(input(true));
      assert.deepEqual(result, {
        sessionId: "target",
        threadId: "adopted-thread",
        messageId: "accepted-message",
        runId: "accepted-run",
        status: "completed",
        delivery: "queued",
      });
      assert.deepEqual(
        f.calls.map(({ name }) => name),
        ["replay"],
      );
    }),
);

it.effect("replays a Native receipt after adoption before routing to the new Runtime writer", () =>
  Effect.gen(function* () {
    const f = fixture({ runtime: true, replay: true, nativeReplay: true });
    const intake = yield* f.makeIntake;
    const result = yield* intake.send(input(true));
    assert.equal(result.threadId, "original-native");
    assert.equal(result.runId, "original-run");
    assert.equal(result.delivery, "queued");
    assert.deepEqual(
      f.calls.map(({ name }) => name),
      ["native-replay"],
    );
  }),
);

it.effect(
  "resumes the original draft launch before inspecting or reimporting its first message",
  () =>
    Effect.gen(function* () {
      const f = fixture({ runtime: true, resume: true });
      const intake = yield* f.makeIntake;
      const result = yield* intake.send(input(true));
      assert.equal(result.runId, "first-run");
      assert.deepEqual(
        f.calls.map(({ name }) => name),
        ["replay", "resume"],
      );
      assert.deepEqual((f.calls[1]!.input as { modeLimit: unknown }).modeLimit, {
        runtimeMode: "full-access",
        interactionMode: "plan",
      });
    }),
);
