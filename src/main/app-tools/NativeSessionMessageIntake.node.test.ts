import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import {
  CodexDelegatedMessages,
  type NativeMessageOptions,
} from "../codex-application/CodexDelegatedMessages";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexAttachments } from "../codex-application/CodexAttachments";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { make } from "./NativeSessionMessageIntake";

type Receipt = AgentRuntimeOperations["native-message.reserve"]["output"];
const fixture = Effect.gen(function* () {
  let receipt: (Receipt & { fingerprint: string }) | null = null;
  const dispatched = yield* Deferred.make<void>();
  const reconciliations: Array<{ hostId: string; threadId: string; messageId: string }> = [];
  const controls = {
    writes: 0,
    rejectedRepliesLost: 0,
    failAfterWrite: false,
    holdAfterWrite: false,
    producerProof: false,
    resumes: 0,
    hydrated: true,
    materializations: 0,
    inspections: 0,
    hostId: "remote",
    canonicalHostId: "remote",
    runtimeBound: false,
    model: "gpt-test",
    plan: false,
    afterMaterialize: () => {},
    beforeDispatch: () => {},
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(CodexAttachments, {
      materializeResources: () =>
        Effect.sync(() => {
          controls.materializations++;
          controls.afterMaterialize();
          return { images: [], fileAttachments: [] };
        }),
    } as never),
    Layer.succeed(CodexGateway, { localHostId: "local" } as never),
    Layer.succeed(ProjectWorkspace, {
      getProjectSession: () =>
        Effect.sync(() => ({
          id: "target",
          archived: false,
          executionRef: controls.runtimeBound ? { threadId: "runtime" } : null,
          thread: {
            threadId: "native-thread",
            executionHostId: controls.hostId,
            backendBinding: { kind: "codex" },
          },
        })),
    } as never),
    Layer.succeed(CodexMainConversationResume, {
      resume: () =>
        Effect.sync(() => {
          controls.resumes++;
          controls.hydrated = true;
          return { status: "ready" };
        }),
    } as never),
    Layer.succeed(CodexThreadDirectory, {
      resolve: () =>
        Effect.sync(() => {
          controls.inspections++;
          return {
            canonical: {
              hostId: controls.canonicalHostId,
              currentPermissions: {
                sandboxPolicy: { type: "dangerFullAccess" },
                approvalPolicy: "never",
                approvalsReviewer: "user",
              },
              latestModel: controls.model,
              latestCollaborationMode: { mode: controls.plan ? "plan" : "default" },
              latestThreadSettings: controls.hydrated
                ? {
                    model: controls.model,
                    collaborationMode: { mode: controls.plan ? "plan" : "default" },
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "dangerFullAccess" },
                  }
                : null,
            },
          };
        }),
    } as never),
    Layer.succeed(AgentRuntimeApplication, {
      nativeMessageReceipt: (input: AgentRuntimeOperations["native-message.receipt"]["input"]) =>
        Effect.gen(function* () {
          if (!receipt) return null;
          if (receipt.fingerprint !== input.fingerprint)
            return yield* Effect.fail(new Error("identity conflict"));
          return receipt.phase === "rejected" ? null : { ...receipt, admitted: false };
        }),
      nativeMessageReserve: (input: AgentRuntimeOperations["native-message.reserve"]["input"]) =>
        Effect.gen(function* () {
          if (receipt) {
            if (receipt.fingerprint !== input.fingerprint)
              return yield* Effect.fail(new Error("identity conflict"));
            if (receipt.phase !== "rejected") return { ...receipt, admitted: false };
          }
          receipt = {
            fingerprint: input.fingerprint,
            sessionId: input.sessionId,
            hostId: input.hostId,
            threadId: input.threadId,
            admitted: true,
            phase: "pending",
            attemptId: input.attemptId,
            result: null,
          };
          return receipt;
        }),
      nativeMessageSettle: (input: AgentRuntimeOperations["native-message.settle"]["input"]) =>
        Effect.gen(function* () {
          if (receipt?.phase === "confirmed") return receipt;
          if (receipt?.phase === "unconfirmed" && input.phase === "rejected")
            return yield* Effect.fail(new Error("uncertain admission cannot be released"));
          receipt = {
            ...receipt!,
            admitted: false,
            phase: input.phase,
            result: input.result ?? null,
          };
          if (input.phase === "rejected" && controls.rejectedRepliesLost > 0) {
            controls.rejectedRepliesLost--;
            return yield* Effect.fail(new Error("rejected settlement reply lost"));
          }
          return receipt;
        }),
    } as never),
    Layer.succeed(CodexDelegatedMessages, {
      reconcile: (input: { hostId: string; threadId: string; messageId: string }) =>
        Effect.sync(() => {
          reconciliations.push(input);
          return {
            messageId: "message",
            runId: controls.producerProof ? "turn" : null,
            status: controls.producerProof ? "running" : "unknown",
            delivery: controls.producerProof ? ("replayed" as const) : ("unconfirmed" as const),
          };
        }),
      send: (
        _thread: string,
        _source: string,
        _prompt: string,
        _overrides: unknown,
        options: NativeMessageOptions,
      ) =>
        Effect.gen(function* () {
          controls.beforeDispatch();
          yield* options.beforeNativeDispatch ?? Effect.void;
          options.onNativeDispatch?.();
          controls.writes++;
          yield* Deferred.succeed(dispatched, undefined);
          if (controls.holdAfterWrite) return yield* Effect.never;
          if (controls.failAfterWrite)
            return yield* Effect.fail(new Error("connection retired after producer admission"));
          return {
            messageId: "message",
            runId: "turn",
            status: "running",
            delivery: "started" as const,
          };
        }),
    } as never),
  );
  return { open: make.pipe(Effect.provide(dependencies)), controls, reconciliations, dispatched };
});
const sendInput = Effect.sync(() => ({
  target: { sessionId: "target" },
  messageId: "message",
  prompt: "Continue",
  mode: "auto" as const,
  attachments: [],
  operationId: createBoundedOperationId("native-explicit"),
  commandIdentity: { prompt: "Continue", mode: "auto" },
  expectedFacts: {
    sessionId: "target",
    threadId: "native-thread",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    nativePermissions: {
      sandboxPolicy: { type: "dangerFullAccess" as const },
      approvalPolicy: "never" as const,
      approvalsReviewer: "user" as const,
    },
  },
}));
type Owner = Effect.Success<typeof make>;
const deliver = Effect.fn(function* (owner: Owner, input: Effect.Success<typeof sendInput>) {
  const prior = yield* owner.lookup(input);
  if (prior) return yield* owner.replay(prior);
  const admission = yield* owner.admit(input);
  if (!admission.admitted) return yield* owner.replay(admission);
  return yield* owner
    .send({ ...input, admission })
    .pipe(
      Effect.onExit((exit) => (exit._tag === "Failure" ? owner.reject(admission) : Effect.void)),
    );
});

it.effect(
  "replays original accepted facts before changed model, mode, binding or unavailable resources",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owner = yield* f.open;
      const input = yield* sendInput;
      const first = yield* deliver(owner, input);
      const inspections = f.controls.inspections;
      f.controls.model = "another-model";
      f.controls.plan = true;
      f.controls.hostId = "another-host";
      f.controls.runtimeBound = true;
      f.controls.hydrated = false;
      const reopened = yield* f.open;
      assert.deepEqual(yield* deliver(reopened, input), first);
      assert.equal(f.controls.writes, 1);
      assert.equal(f.controls.inspections, inspections);
      assert.equal(f.controls.materializations, 1);
      assert.equal(f.controls.resumes, 0);
      assert.isEmpty(f.reconciliations);
    }),
);

it.effect(
  "reconciles uncertain delivery only on its original host, without resuming or preparing it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.controls.failAfterWrite = true;
      const owner = yield* f.open;
      const input = yield* sendInput;
      assert.equal((yield* deliver(owner, input)).delivery, "unconfirmed");
      const inspections = f.controls.inspections;
      f.controls.hostId = "new-host";
      f.controls.runtimeBound = true;
      f.controls.hydrated = false;
      const reopened = yield* f.open;
      assert.equal((yield* deliver(reopened, input)).delivery, "unconfirmed");
      f.controls.producerProof = true;
      assert.equal((yield* deliver(reopened, input)).runId, "turn");
      assert.equal(f.controls.writes, 1);
      assert.equal(f.controls.inspections, inspections);
      assert.equal(f.controls.materializations, 1);
      assert.equal(f.controls.resumes, 0);
      assert.deepEqual(
        f.reconciliations.map((value) => value.hostId),
        ["remote", "remote"],
      );
    }),
);

it.effect("rejects changed explicit arguments before any fresh preparation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const owner = yield* f.open;
    const input = yield* sendInput;
    yield* deliver(owner, input);
    assert.equal(
      (yield* deliver(owner, {
        ...input,
        prompt: "Different",
        commandIdentity: { prompt: "Different", mode: "auto" },
      }).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(f.controls.writes, 1);
    assert.equal(f.controls.materializations, 1);
  }),
);

it.effect("releases a proved pre-dispatch refusal once and permits a new safe attempt", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const owner = yield* f.open;
    const input = yield* sendInput;
    const admission = yield* owner.admit(input);
    f.controls.rejectedRepliesLost = 1;
    assert.equal((yield* owner.reject(admission).pipe(Effect.result))._tag, "Failure");
    yield* owner.reject(admission);
    yield* owner.reject(admission);
    const next = yield* owner.admit(input);
    assert.isTrue(next.admitted);
    assert.notEqual(next.attemptId, admission.attemptId);
    yield* owner.send({ ...input, admission: next });
    assert.equal(f.controls.writes, 1);
  }),
);

it.effect(
  "keeps cancellation after producer dispatch fenced against finalizer release and retry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.controls.holdAfterWrite = true;
      const owner = yield* f.open;
      const input = yield* sendInput;
      const admission = yield* owner.admit(input);
      const call = yield* owner.send({ ...input, admission }).pipe(Effect.forkChild);
      yield* Deferred.await(f.dispatched);
      yield* Fiber.interrupt(call);
      yield* owner.reject(admission);
      assert.equal((yield* deliver(owner, input)).delivery, "unconfirmed");
      assert.equal(f.controls.writes, 1);
    }),
);

for (const stage of ["afterMaterialize", "beforeDispatch"] as const)
  it.effect(`refuses a changed Core host ${stage} before a producer message write`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owner = yield* f.open;
      const input = yield* sendInput;
      f.controls[stage] = () => {
        f.controls.hostId = "other-host";
      };
      assert.equal((yield* deliver(owner, input).pipe(Effect.result))._tag, "Failure");
      assert.equal(f.controls.writes, 0);
      assert.isNull(yield* owner.lookup(input));
    }),
  );

it.effect("keeps caller inspection read-only and prepares a cold target only when authorized", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.controls.hydrated = false;
    const owner = yield* f.open;
    assert.equal(
      (yield* owner.inspect({ sessionId: "target" }).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(f.controls.resumes, 0);
    assert.equal((yield* owner.prepare({ sessionId: "target" })).modelSelection.model, "gpt-test");
    assert.equal(f.controls.resumes, 1);
  }),
);

it.effect(
  "rejects every Native execution selector before preparing or reserving an execution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owner = yield* f.open;
      for (const threadId of ["another-native-thread", "native-thread"])
        assert.equal(
          (yield* owner
            .prepare({ sessionId: "target", execution: { threadId } })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      assert.equal(f.controls.resumes, 0);
    }),
);

it.effect(
  "refuses cached permission facts retained from a different physical host without resuming",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owner = yield* f.open;
      f.controls.canonicalHostId = "retired-host";
      assert.equal(
        (yield* owner.inspect({ sessionId: "target" }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(f.controls.resumes, 0);
      assert.equal(f.controls.materializations, 0);
      assert.equal(f.controls.writes, 0);
    }),
);

it.effect("a concurrent no-proof replay cannot poison a fresh attempt's pre-dispatch refusal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const firstOwner = yield* f.open;
    const input = yield* sendInput;
    const fresh = yield* firstOwner.admit(input);
    const concurrentOwner = yield* f.open;
    const pending = yield* concurrentOwner.lookup(input);
    assert.isNotNull(pending);
    assert.equal((yield* concurrentOwner.replay(pending!)).delivery, "unconfirmed");
    yield* firstOwner.reject(fresh);
    assert.isNull(yield* concurrentOwner.lookup(input));
    const retry = yield* concurrentOwner.admit(input);
    assert.isTrue(retry.admitted);
    yield* concurrentOwner.send({ ...input, admission: retry });
    assert.equal(f.controls.writes, 1);
  }),
);
