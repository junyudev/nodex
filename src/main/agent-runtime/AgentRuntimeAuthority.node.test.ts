import { assert, it } from "@effect/vitest";
import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import {
  make,
  type AgentRuntimeAuthorityEvidence,
  type AgentRuntimeAuthorityIdentity,
  type AgentRuntimeRunAuthorityIdentity,
  type AgentRuntimeRunAuthorityEvidence,
  type AgentRuntimeNativeSessionAuthorityEvidence,
  type AgentRuntimeNativeToolCall,
} from "./AgentRuntimeAuthority";

type Authority = components["schemas"]["ProjectWorkspaceTurnAuthority"];
type Stored = {
  readonly identity: AgentRuntimeAuthorityIdentity;
  readonly authority: Authority;
  active: boolean;
};
const key = (identity: AgentRuntimeAuthorityIdentity) =>
  JSON.stringify([
    identity.runtime_id,
    identity.thread_id,
    identity.lease_id,
    "run_id" in identity
      ? ["run", identity.run_id]
      : [
          "native-session",
          identity.provider_session_id,
          identity.native_generation,
          identity.incarnation_id,
        ],
  ]);
const call: AgentRuntimeNativeToolCall = {
  providerThreadId: "native-session",
  providerTurnId: "native-turn",
  callId: "tool-call",
};
const identity = (
  lease = "lease:one",
  thread = "thread:root",
  run = "run:one",
): AgentRuntimeRunAuthorityIdentity => ({
  runtime_id: "engine",
  thread_id: thread,
  run_id: run,
  lease_id: lease,
});
const evidence = (lease = "lease:one"): AgentRuntimeRunAuthorityEvidence => ({
  runtimeId: "engine",
  leaseId: lease,
  threadId: "thread:root",
  runId: "run:one",
  projectId: "project",
  rootThreadId: "thread:root",

  status: "running",
  archived: false,
  nativeCall: call,
  providerSessionId: "native-session",
  nativeGeneration: 1,
});
const nativeEvidence = (
  incarnationId = "incarnation:one",
): AgentRuntimeNativeSessionAuthorityEvidence => ({
  ...evidence(),
  runId: null,
  status: null,
  providerSessionId: "native-session",
  nativeGeneration: 1,
  incarnationId,
  nativeCall: { ...call, providerTurnId: null },
});

const setup = (records = new Map<string, Stored>()) => {
  const applies: ProjectWorkspaceApplyInput[] = [];
  const reads: ProjectWorkspaceRead[] = [];
  const actors: unknown[] = [];
  const state: {
    current: AgentRuntimeAuthorityEvidence;
    withdrawOnAdmission: boolean;
    failCloseOnce: boolean;
  } = {
    current: evidence(),
    withdrawOnAdmission: false,
    failCloseOnce: false,
  };
  const binding = {
    session_id: "session:anchor",
    project_id: "project",
    runtime_id: "engine",
    runtime_thread_id: "thread:root",
    launch_request_id: "launch",
    bound_at: "2026-10-14T00:00:00.000Z",
  };
  const read = (input: ProjectWorkspaceRead) =>
    Effect.sync(() => {
      reads.push(input);
      if (input.kind === "agent_runtime_session_binding_by_execution")
        return {
          value: {
            kind: "agent_runtime_session_binding",
            binding:
              input.runtime_id === binding.runtime_id &&
              input.runtime_thread_id === binding.runtime_thread_id
                ? binding
                : null,
          },
        };
      if (
        input.kind === "agent_runtime_turn_authority" ||
        input.kind === "agent_runtime_native_session_authority"
      ) {
        const stored = records.get(key(input.identity));
        const available = stored && stored.active;
        return {
          value: {
            kind: input.kind,
            resolution: {
              persisted: Boolean(stored),
              admitted_at_ms: available ? 42 : null,
              authority: available ? stored.authority : null,
            },
          },
        };
      }
      throw new Error("unexpected Core read");
    });
  const apply = (input: ProjectWorkspaceApplyInput) =>
    Effect.gen(function* () {
      actors.push(yield* CoreApplicationAgent);
      applies.push(input);
      const intent = input.intent;
      if (
        intent.kind === "admit_agent_runtime_turn_authority" ||
        intent.kind === "admit_agent_runtime_native_session_authority"
      ) {
        if (records.get(key(intent.identity))?.active === false)
          return yield* Effect.fail(new Error("Retired identity cannot be admitted"));
        records.set(key(intent.identity), {
          identity: intent.identity,
          active: true,
          authority: {
            thread_id: `core:${intent.identity.thread_id}`,
            turn_id:
              "run_id" in intent.identity
                ? `core:${intent.identity.run_id}:${intent.identity.lease_id}`
                : `runtime-native-session:${intent.identity.incarnation_id}`,
            root_thread_id: "core:thread:root",
            actor_project_id: binding.project_id,
            library_id: "library",
            store_epoch: "epoch",
          },
        });
        if (state.withdrawOnAdmission)
          state.current =
            state.current.runId === null
              ? { ...state.current, incarnationId: "retired" }
              : { ...state.current, status: "cancelled" };
      }
      if (
        intent.kind === "revoke_agent_runtime_turn_authority" ||
        intent.kind === "revoke_agent_runtime_native_session_authority"
      ) {
        const stored = records.get(key(intent.identity));
        if (stored) stored.active = false;
      }
      if (intent.kind === "revoke_agent_runtime_authorities") {
        if (state.failCloseOnce) {
          state.failCloseOnce = false;
          return yield* Effect.fail(new Error("Core revocation unavailable"));
        }
        for (const stored of records.values()) {
          if (
            stored.identity.runtime_id === intent.runtime_id &&
            (!intent.lease_id || stored.identity.lease_id === intent.lease_id)
          )
            stored.active = false;
        }
      }
      return {};
    });
  const owner = (leaseId = "lease:one") =>
    make({
      runtimeId: "engine",
      leaseId,
      observe: () => Effect.sync(() => state.current),
    }).pipe(
      Effect.provideService(CoreModules, { workspace: { read, apply } } as never),
      Effect.provideService(CoreAuthority, {
        identity: { profileId: "profile", libraryId: "library", storeEpoch: "epoch" },
      } as never),
    );
  return { state, applies, reads, actors, records, owner };
};

it.effect("binds the engine root to its stable Session and returns Core-authored provenance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner();
      const prepared = yield* owner.prepareTurn({ evidence: evidence() });
      assert.equal(prepared.sessionId, "session:anchor");
      assert.equal(prepared.identity.lease_id, "lease:one");
      assert.equal(prepared.provenance.profile_id, "profile");
      assert.equal(prepared.provenance.authority.thread_id, "core:thread:root");
      const captured = yield* owner.capture({
        evidence: evidence(),
        identity: prepared.identity,
        nativeCall: call,
      });
      assert.deepEqual(captured.provenance, prepared.provenance);
      assert.isTrue(
        fixture.reads.some(
          (input) =>
            input.kind === "agent_runtime_session_binding_by_execution" &&
            input.runtime_id === "engine" &&
            input.runtime_thread_id === "thread:root",
        ),
      );
      assert.equal(
        fixture.applies.filter(
          (input) => input.intent.kind === "admit_agent_runtime_turn_authority",
        ).length,
        1,
      );
      assert.deepEqual(fixture.actors, [null]);
    }),
  ),
);

it.effect(
  "rejects stale generations, unbound roots, wrong Projects, and misleading Session hints",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const patch of [
          { leaseId: "lease:previous" },
          { rootThreadId: "thread:unbound" },
          { runtimeId: "other-engine" },
        ] satisfies ReadonlyArray<Partial<AgentRuntimeRunAuthorityEvidence>>) {
          const fixture = setup();
          const current = { ...evidence(), ...patch };
          fixture.state.current = current;
          const owner = yield* fixture.owner();
          const failure = yield* Effect.flip(owner.prepareTurn({ evidence: current }));
          assert.equal(failure._tag, "AgentRuntimeAuthorityError");
          assert.equal(fixture.applies.length, 0);
        }
        const fixture = setup();
        const owner = yield* fixture.owner();
        yield* Effect.flip(
          owner.prepareTurn({ evidence: evidence(), sessionId: "session:another" }),
        );
        assert.equal(fixture.applies.length, 0);
      }),
    ),
);

it.effect("completed parents and child Runs retain their exact admitted connection context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = setup();
      f.state.current = { ...evidence(), status: "completed" };
      const owner = yield* f.owner();
      const parent = yield* owner.prepareTurn({ evidence: { ...evidence(), status: "completed" } });
      assert.deepEqual(
        (yield* owner.capture({
          evidence: f.state.current,
          identity: parent.identity,
          nativeCall: call,
        })).context,
        parent.context,
      );
      f.state.current = {
        ...evidence(),
        threadId: "thread:child",
        runId: "run:child",
      };
      const child = yield* owner.prepareTurn({
        evidence: { ...evidence(), threadId: "thread:child", runId: "run:child" },
      });
      assert.equal(child.sessionId, parent.sessionId);
      assert.equal(child.context.turnId, "core:run:child:lease:one");
    }),
  ),
);

it.effect("native tool capture revalidates the exact call, Run lifetime, and Core revocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner();
      const prepared = yield* owner.prepareTurn({ evidence: evidence() });
      const capture = { evidence: evidence(), identity: prepared.identity, nativeCall: call };
      yield* Effect.flip(
        owner.capture({ ...capture, nativeCall: { ...call, callId: "another-call" } }),
      );
      fixture.state.current = { ...evidence(), status: "cancelled" };
      yield* Effect.flip(owner.capture(capture));
      fixture.state.current = evidence();
      yield* owner.revoke(prepared.identity);
      yield* Effect.flip(owner.capture(capture));
    }),
  ),
);

it.effect("withdrawal during admission revokes the credential before it can be returned", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = setup();
      fixture.state.withdrawOnAdmission = true;
      const owner = yield* fixture.owner();
      yield* Effect.flip(owner.prepareTurn({ evidence: evidence() }));
      assert.isFalse(fixture.records.get(key(identity()))?.active);
      assert.equal(
        fixture.applies.filter(
          (input) => input.intent.kind === "revoke_agent_runtime_turn_authority",
        ).length,
        1,
      );
    }),
  ),
);

it.effect("an older scope finalizer cannot revoke the replacement connection's same Run", () =>
  Effect.gen(function* () {
    const records = new Map<string, Stored>();
    const previous = setup(records);
    const next = setup(records);
    next.state.current = evidence("lease:next");
    const previousScope = yield* Scope.make();
    const nextScope = yield* Scope.make();
    try {
      const oldOwner = yield* previous.owner().pipe(Scope.provide(previousScope));
      const old = yield* oldOwner.prepareTurn({ evidence: evidence() });
      const newOwner = yield* next.owner("lease:next").pipe(Scope.provide(nextScope));
      const current = yield* newOwner.prepareTurn({ evidence: evidence("lease:next") });
      yield* Scope.close(previousScope, Exit.void);
      assert.isFalse(records.get(key(old.identity))?.active);
      assert.isTrue(records.get(key(current.identity))?.active);
      yield* Effect.flip(
        oldOwner.capture({ evidence: evidence(), identity: old.identity, nativeCall: call }),
      );
      yield* newOwner.capture({
        evidence: next.state.current,
        identity: current.identity,
        nativeCall: call,
      });
    } finally {
      yield* Scope.close(previousScope, Exit.void);
      yield* Scope.close(nextScope, Exit.void);
    }
  }),
);

it.effect("failed cleanup keeps captures fenced and permits revocation to finish on retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner();
      const prepared = yield* owner.prepareTurn({ evidence: evidence() });
      fixture.state.failCloseOnce = true;
      yield* Effect.flip(owner.close);
      yield* Effect.flip(
        owner.capture({ evidence: evidence(), identity: prepared.identity, nativeCall: call }),
      );
      assert.isTrue(fixture.records.get(key(prepared.identity))?.active);
      yield* owner.close;
      assert.isFalse(fixture.records.get(key(prepared.identity))?.active);
    }),
  ),
);

it.effect("engine Project metadata does not restrict current Session content access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = setup();
      f.state.current = { ...evidence(), projectId: "former-project" };
      const owner = yield* f.owner();
      const prepared = yield* owner.prepareTurn({
        evidence: { ...evidence(), projectId: "former-project" },
      });
      assert.equal(prepared.context.actorProjectId, "project");
      assert.deepEqual(
        (yield* owner.capture({
          evidence: f.state.current,
          identity: prepared.identity,
          nativeCall: call,
        })).context,
        prepared.context,
      );
    }),
  ),
);

it.effect("native Session admission carries no Run and preserves the current product route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = setup();
      f.state.current = { ...nativeEvidence(), projectId: "former-project" };
      const owner = yield* f.owner();
      const prepared = yield* owner.prepareNativeSession({ evidence: f.state.current });
      assert.equal(prepared.sessionId, "session:anchor");
      assert.notProperty(prepared.identity, "run_id");
      assert.equal(prepared.context.turnId, "runtime-native-session:incarnation:one");
      assert.equal(prepared.context.actorProjectId, "project");
      const admitted = f.applies.find(
        (input) => input.intent.kind === "admit_agent_runtime_native_session_authority",
      )!;
      assert.equal(admitted.intent.kind, "admit_agent_runtime_native_session_authority");
      const captured = yield* owner.capture({
        evidence: f.state.current,
        identity: prepared.identity,
        nativeCall: { ...call, providerTurnId: null },
      });
      assert.deepEqual(captured.provenance, prepared.provenance);
      assert.isTrue(f.reads.every((input) => input.kind !== "agent_runtime_turn_authority"));
      const repeated = yield* owner.prepareNativeSession({ evidence: f.state.current });
      assert.deepEqual(repeated.provenance, prepared.provenance);
      assert.equal(
        f.applies.filter(
          (input) => input.intent.kind === "admit_agent_runtime_native_session_authority",
        ).length,
        1,
      );
    }),
  ),
);

it.effect("cancelled native incarnations cannot borrow replacement Session credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = setup();
      f.state.current = nativeEvidence();
      const owner = yield* f.owner();
      const old = yield* owner.prepareNativeSession({ evidence: nativeEvidence() });
      f.state.current = nativeEvidence("incarnation:next");
      yield* Effect.flip(
        owner.capture({
          evidence: nativeEvidence(),
          identity: old.identity,
          nativeCall: { ...call, providerTurnId: null },
        }),
      );
      yield* owner.revoke(old.identity);
      const next = yield* owner.prepareNativeSession({ evidence: f.state.current });
      assert.notDeepEqual(old.identity, next.identity);
      f.state.current = nativeEvidence();
      yield* Effect.flip(owner.prepareNativeSession({ evidence: f.state.current }));
      assert.isFalse(f.records.get(key(old.identity))?.active);
      assert.isTrue(f.records.get(key(next.identity))?.active);
    }),
  ),
);

it.effect("native cancellation during admission withdraws the just-created Core credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = setup();
      f.state.current = nativeEvidence();
      f.state.withdrawOnAdmission = true;
      const owner = yield* f.owner();
      yield* Effect.flip(owner.prepareNativeSession({ evidence: nativeEvidence() }));
      assert.isFalse([...f.records.values()][0]?.active);
      assert.equal(
        f.applies.filter(
          (input) => input.intent.kind === "revoke_agent_runtime_native_session_authority",
        ).length,
        1,
      );
    }),
  ),
);
