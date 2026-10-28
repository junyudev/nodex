import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { RustDataAuthorityRuntime } from "../../../src/main/core-client";
import {
  CoreAuthority,
  CoreSessionAccess,
  type CoreAuthorityState,
} from "../../../src/main/core-runtime/CoreAuthority";
import { CoreModules, live as coreModulesLive } from "../../../src/main/core-runtime/CoreModules";
import {
  InboxApplication,
  live as inboxApplicationLive,
} from "../../../src/main/inbox-application/InboxApplication";
import { AgentRuntimeApplication } from "../../../src/main/agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../../../src/main/settings/ApplicationSettings";
import { DEFAULT_INBOX_SETTINGS } from "../../../src/shared/inbox";
import { live as storeAdministrationLive } from "../../../src/main/core-runtime/StoreAdministration";
import {
  DatabaseModule,
  live as databaseModuleLive,
} from "../../../src/main/database-application/DatabaseModule";
import {
  LibraryModule,
  live as libraryModuleLive,
} from "../../../src/main/library-application/LibraryModule";
import {
  ProjectWorkspace,
  live as projectWorkspaceLive,
} from "../../../src/main/project-application/ProjectWorkspace";

const runWithScenarioCore = <A, E>(
  runtime: RustDataAuthorityRuntime,
  operation: Effect.Effect<A, E, CoreAuthority | CoreSessionAccess | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* SubscriptionRef.make<CoreAuthorityState>({
          kind: "ready",
          generation: runtime.rootClient.handshake.generation.start_nonce,
        });
        const authority = CoreAuthority.of({
          identity: runtime.identity,
          initialLaunch: {
            executablePath: runtime.launch.executablePath,
            startedProcessId: runtime.launch.startedProcessId,
            timings: runtime.launch.timings,
          },
          state,
          retry: Effect.void,
          requestRelaunch: Effect.void,
          failApplication: () => Effect.succeed(true),
        });
        const sessions = CoreSessionAccess.of({
          handshake: Effect.succeed(runtime.rootClient.handshake),
          use: (_operation, operation, options) =>
            Effect.promise((signal) =>
              operation(
                options?.projectId
                  ? runtime.clientForProject(options.projectId)
                  : runtime.rootClient,
                signal,
              ),
            ),
        });
        return yield* operation.pipe(
          Effect.provideService(CoreAuthority, authority),
          Effect.provideService(CoreSessionAccess, sessions),
        );
      }),
    ),
  );

/** Applies or reads Automation state for a scenario, outside Electron Main. */
export const runScenarioAutomation = <A, E>(
  runtime: RustDataAuthorityRuntime,
  use: (automation: CoreModules["Service"]["automation"]) => Effect.Effect<A, E>,
): Promise<A> =>
  runWithScenarioCore(
    runtime,
    Effect.gen(function* () {
      const context = yield* Layer.build(coreModulesLive);
      return yield* use(Context.get(context, CoreModules).automation);
    }),
  );

/** One-shot Effect root for scenario tooling that runs outside Electron Main. */
export const runScenarioDatabase = <A, E>(
  runtime: RustDataAuthorityRuntime,
  use: (database: DatabaseModule["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  runWithScenarioCore(
    runtime,
    Effect.gen(function* () {
      const context = yield* Layer.build(databaseModuleLive);
      return yield* use(Context.get(context, DatabaseModule));
    }),
  );

/** Uses the same final minimum-commit capability as production Library reads. */
export const runScenarioLibrary = <A, E>(
  runtime: RustDataAuthorityRuntime,
  use: (library: LibraryModule["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  runWithScenarioCore(
    runtime,
    Effect.gen(function* () {
      const context = yield* Layer.build(libraryModuleLive);
      return yield* use(Context.get(context, LibraryModule));
    }),
  );

/** Uses the production Project Workspace capability rather than a scenario-only Promise facade. */
export const runScenarioInbox = <A, E>(
  runtime: RustDataAuthorityRuntime,
  use: (inbox: InboxApplication["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  runWithScenarioCore(
    runtime,
    Effect.gen(function* () {
      const coreContext = yield* Layer.build(coreModulesLive);
      const core = Context.get(coreContext, CoreModules);
      const coreLayer = Layer.succeed(CoreModules, core);
      const inboxContext = yield* Layer.build(
        inboxApplicationLive.pipe(
          Layer.provide(storeAdministrationLive.pipe(Layer.provideMerge(coreLayer))),
          // Scenario content setup has no execution process; new Agent work is never seeded.
          Layer.provide(
            Layer.succeed(AgentRuntimeApplication, {
              catalog: () => Effect.die("Scenario capture must not start an Agent catalog"),
            } as unknown as AgentRuntimeApplication["Service"]),
          ),
          Layer.provide(
            Layer.succeed(ApplicationSettings, {
              snapshot: () => Effect.succeed({ inbox: DEFAULT_INBOX_SETTINGS }),
            } as unknown as ApplicationSettings["Service"]),
          ),
        ),
      );
      return yield* use(Context.get(inboxContext, InboxApplication));
    }),
  );

export const runScenarioProjectWorkspace = <A, E>(
  runtime: RustDataAuthorityRuntime,
  use: (workspace: ProjectWorkspace["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  runWithScenarioCore(
    runtime,
    Effect.gen(function* () {
      const coreContext = yield* Layer.build(coreModulesLive);
      const core = Context.get(coreContext, CoreModules);
      const workspaceContext = yield* Layer.build(
        projectWorkspaceLive.pipe(Layer.provide(Layer.succeed(CoreModules, core))),
      );
      return yield* use(Context.get(workspaceContext, ProjectWorkspace));
    }),
  );
