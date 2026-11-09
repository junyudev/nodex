/* @effect-diagnostics asyncFunction:off nodeBuiltinImport:off -- Real Core admission owns the scenario lifetime. */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoreClient } from "../../main/core-client/core-client";
import { enrollRemoteCore } from "../../main/core-client/remote-http";
import { CoreAuthority, CoreSessionAccess } from "../../main/core-runtime/CoreAuthority";
import { CoreModules, live as modules } from "../../main/core-runtime/CoreModules";
import { coreRuntimeError } from "../../main/core-runtime/CoreRuntimeError";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import { DEFAULT_INBOX_SETTINGS } from "../../shared/inbox";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import { HostInvocation } from "../HostInvocation";
import { make } from "./CoordinatorSession";

test("Member opens admit reads while the lazy Coordinator bootstrap retains its operator", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "coordinator-member-owner",
    });
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const enroll = async (name: string) => {
      const invite = await host.spaceInvite({ role: "member" });
      const identity = await enrollRemoteCore(listener, {
        code: invite.code,
        display_name: name,
        device_label: name,
      });
      const client = await CoreClient.connectRemote({
        ...listener,
        deviceCredential: identity.device_credential,
        spaceId: identity.space_id,
        buildId: "coordinator-member-owner",
      });
      return { identity, client };
    };
    const alice = await enroll("Alice");
    const bob = await enroll("Bob");
    const lease = await host.registerHost({ instance: createUuidV7() });
    const issue = async (member: typeof bob) => {
      const pending = member.client.hostCall({ operation: "coordinator_open", input: {} });
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const invocation = await host.pollHost(lease);
      if (!invocation) throw new Error("Missing Coordinator invocation");
      return {
        proof: invocation.credential,
        finish: async () => {
          const completion = await host
            .completeHost({
              ...lease,
              id: invocation.id,
              result: { status: "ok", value: null },
            })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
          return { completion, outcome: await outcome };
        },
      };
    };
    const access = CoreSessionAccess.of({
      handshake: Effect.succeed(host.handshake),
      use: (name, run) =>
        Effect.flatMap(HostInvocation, (proof) =>
          Effect.tryPromise({
            try: (signal) => run(proof ? host.forInvocation(proof) : host, signal),
            catch: (cause) =>
              coreRuntimeError({ operation: name, reason: "operation", retryable: false, cause }),
          }),
        ),
    });
    const layer = modules.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access)));
    // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- The authoritative Core scenario owns this Promise lifetime.
    await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* CoreModules;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let launches = 0;
        let createdSession: string | null = null;
        const runtime = {
          catalog: () =>
            Effect.succeed([
              {
                instanceId: "codex",
                enabled: true,
                installed: true,
                status: "ready",
                driver: "codex",
                models: [{ slug: "model", name: "Model", isCustom: false, capabilities: {} }],
              },
            ]),
          sessionMetadata: () => Effect.succeed([{ threadId: "coordinator-thread" }]),
          launch: (input: AgentRuntimeLaunch) =>
            Effect.gen(function* () {
              launches++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              // This actual Core command refuses Member authority, including Owner membership.
              yield* core.workspace.apply({
                operationId: createBoundedOperationId("coordinator.bootstrap"),
                intent: {
                  kind: "create_agent_runtime_session",
                  coordinator: true,
                  session_id: input.sessionId,
                  project_id: null,
                  title: input.title,
                  initial_page_ids: [],
                  runtime_id: "coordinator-runtime",
                  runtime_thread_id: "coordinator-thread",
                  launch_request_id: input.launchId,
                },
              });
              createdSession = input.sessionId;
              return { sessionId: input.sessionId };
            }),
        } as unknown as AgentRuntimeApplication["Service"];
        const coordinator = yield* make.pipe(
          Effect.provideService(CoreAuthority, {
            identity: { profileId: host.handshake.generation.profile_id },
          } as CoreAuthority["Service"]),
          Effect.provideService(DatabaseNotifierRuntime, {
            projectSessionInvalidations: Stream.never,
          } as unknown as DatabaseNotifierRuntime["Service"]),
          Effect.provideService(ApplicationSettings, {
            snapshot: () => Effect.succeed({ inbox: DEFAULT_INBOX_SETTINGS }),
          } as unknown as ApplicationSettings["Service"]),
          Effect.provideService(AgentRuntimeApplication, runtime),
        );
        const retired = yield* Effect.promise(() => issue(bob));
        expect((yield* Effect.promise(retired.finish)).completion).toEqual({ value: true });
        const refused = yield* coordinator
          .ensure()
          .pipe(Effect.provideService(HostInvocation, retired.proof), Effect.exit);
        expect(Exit.isFailure(refused)).toBe(true);
        expect(launches).toBe(0);

        const opening = yield* Effect.promise(() => issue(bob));
        const waiting = yield* coordinator
          .ensure()
          .pipe(
            Effect.provideService(HostInvocation, opening.proof),
            Effect.forkScoped({ startImmediately: true }),
          );
        yield* Deferred.await(entered);
        yield* Effect.promise(() => host.spaceRevokeDevice({ device_id: bob.identity.device_id }));
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true);
        const withdrawn = yield* Effect.promise(opening.finish);
        expect(withdrawn.completion).toHaveProperty("error");
        expect(withdrawn.outcome).toHaveProperty("error");
        expect(launches).toBe(1);
        expect(createdSession).not.toBeNull();

        const allowed = yield* Effect.promise(() => issue(alice));
        const selected = yield* coordinator
          .ensure()
          .pipe(Effect.provideService(HostInvocation, allowed.proof));
        expect((yield* Effect.promise(allowed.finish)).completion).toEqual({ value: true });
        expect(selected).toBe(createdSession);
        expect(yield* coordinator.ensure()).toBe(selected);
        expect(launches).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
});
