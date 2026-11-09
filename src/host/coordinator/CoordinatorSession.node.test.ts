import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import { DEFAULT_INBOX_SETTINGS } from "../../shared/inbox";
import { make } from "./CoordinatorSession";

it.effect("creates one projectless Nodex Session lazily and resets to a new launch identity", () =>
  Effect.gen(function* () {
    let bound: string | null = null;
    let runtimePresent = true;
    const launched: AgentRuntimeLaunch[] = [];
    const archived: string[] = [];
    const coordinator = yield* make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.never,
      } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          read: (input: ProjectWorkspaceRead) =>
            Effect.succeed({
              value:
                input.kind === "session"
                  ? { kind: "session", session: { id: bound, archived: false } }
                  : input.kind === "agent_runtime_session_binding"
                    ? {
                        kind: input.kind,
                        binding: {
                          session_id: bound,
                          runtime_id: "runtime",
                          runtime_thread_id: "thread",
                          launch_request_id: launched[0]!.launchId,
                          bound_at: "1970-01-01T00:00:00.000Z",
                        },
                      }
                    : { kind: "read_coordinator", session_id: bound },
            }),
          apply: (input: ProjectWorkspaceApplyInput) =>
            Effect.sync(() => {
              if (input.intent.kind !== "unbind_coordinator") return;
              assert.equal(input.intent.session_id, bound);
              bound = null;
            }),
        },
      } as never),
      Effect.provideService(ApplicationSettings, {
        snapshot: () =>
          Effect.succeed({
            inbox: {
              ...DEFAULT_INBOX_SETTINGS,
              suggestionAgent: { ...DEFAULT_INBOX_SETTINGS.suggestionAgent, model: "chosen-model" },
            },
          }),
      } as never),
      Effect.provideService(AgentRuntimeApplication, {
        sessionMetadata: () => Effect.succeed(runtimePresent ? [{ threadId: "thread" }] : []),
        catalog: () =>
          Effect.succeed([
            {
              instanceId: "codex",
              enabled: true,
              installed: true,
              status: "ready",
              driver: "codex",
              models: [{ slug: "chosen-model", name: "Chosen", isCustom: false, capabilities: {} }],
            },
          ]),
        launch: (input: AgentRuntimeLaunch) =>
          Effect.sync(() => {
            launched.push(input);
            runtimePresent = true;
            bound = input.sessionId;
            return { sessionId: input.sessionId };
          }),
        archiveSession: (input: { payload: { sessionId: string } }) =>
          Effect.sync(() => {
            archived.push(input.payload.sessionId);
          }),
      } as never),
    );
    assert.isEmpty(launched);
    const id = yield* coordinator.ensure();
    assert.equal(yield* coordinator.ensure(), id);
    assert.lengthOf(launched, 1);
    assert.deepInclude(launched[0], {
      projectId: null,
      title: "Nodex",
      messageOrigin: "host",
      coordinator: true,
    });
    assert.equal(launched[0]!.modelSelection.model, "chosen-model");
    assert.isTrue(yield* coordinator.isCoordinator(id));
    assert.isFalse(yield* coordinator.isCoordinator("work"));
    runtimePresent = false;
    assert.equal(yield* coordinator.ensure(), id);
    assert.lengthOf(launched, 2);
    assert.equal(launched[1]!.launchId, launched[0]!.launchId);
    assert.equal(launched[1]!.modelSelection.model, "chosen-model");
    yield* coordinator.reset();
    assert.deepEqual(archived, [id]);
    assert.isNull(bound);
    assert.isFalse(yield* coordinator.isCoordinator(id));
    assert.notEqual(yield* coordinator.ensure(), id);
    assert.notEqual(launched[0]!.launchId, launched[2]!.launchId);
  }).pipe(Effect.scoped),
);
