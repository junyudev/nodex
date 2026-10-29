import * as Effect from "effect/Effect";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/board-dense";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { StoreAdministration } from "../core-runtime/StoreAdministration";
import { make as makeInboxApplication } from "./InboxApplication";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  DEFAULT_INBOX_SETTINGS,
  LIBRARY_INBOX,
  type InboxScope,
  type InboxSettings,
} from "../../shared/inbox";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { InboxApplication } from "./InboxApplication";

/** Uses a caller-owned capture identity even when a test only needs a single send. */
export const captureInbox = (
  inbox: InboxApplication["Service"],
  body: string,
  scope: InboxScope = LIBRARY_INBOX,
) =>
  Effect.gen(function* () {
    const summary = yield* inbox.summary({ scope });
    return (yield* inbox.send({
      scope,
      body,
      operationId: createBoundedOperationId("test.inbox.send"),
      pageId: createUuidV7(),
      documentId: createUuidV7(),
      issuedAt: Date.now(),
      storeEpoch: summary.storeEpoch,
    })).value;
  });

type ScenarioClient = CoreScenarioContext["client"];

/** Holds one isolated Core scenario open for the lifetime of the test Scope. */
const scenario = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly context: CoreScenarioContext; readonly close: () => Promise<void> }>(
        (resolve, reject) => {
          let release!: () => void;
          const released = new Promise<void>((done) => (release = done));
          const finished = withCoreScenario({ scenarioId: BOARD_DENSE_SCENARIO_ID }, (context) => {
            resolve({
              context,
              close: () => {
                release();
                return finished;
              },
            });
            return released;
          });
          finished.catch(reject);
        },
      ),
  ),
  ({ close }) => Effect.promise(close),
);

const coreModulesOver = (client: ScenarioClient) => {
  const call = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        coreRuntimeError({ operation, reason: "operation", retryable: false, cause }),
    });
  return CoreModules.of({
    workspace: {
      read: (read: Parameters<ScenarioClient["workspaceRead"]>[0]) =>
        call("workspace.read", () => client.workspaceRead(read)),
      apply: (input: Parameters<ScenarioClient["workspaceApply"]>[0]) =>
        call("workspace.apply", () => client.workspaceApply(input)),
    },
    library: {
      read: (read: Parameters<ScenarioClient["libraryRead"]>[0]) =>
        call("library.read", () => client.libraryRead(read)),
    },
    document: {
      apply: (input: Parameters<ScenarioClient["documentApply"]>[0]) =>
        call("document.apply", () => client.documentApply(input)),
    },
  } as never);
};

/**
 * The Inbox Interface over a fresh, isolated real Core, so its Core and Page writes are tested
 * through the same transport the desktop app uses.
 */
export const inboxOverRealCore = (
  requestErasure: Effect.Effect<void> = Effect.void,
  /** The Agent catalog a chat handoff resolves against; content tests never start one. */
  catalog: AgentRuntimeApplication["Service"]["catalog"] = () =>
    Effect.die("Content tests must not start an Agent catalog"),
  inboxSettings: () => InboxSettings = () => DEFAULT_INBOX_SETTINGS,
) =>
  Effect.gen(function* () {
    const { context } = yield* scenario;
    const inbox = yield* makeInboxApplication.pipe(
      Effect.provideService(CoreModules, coreModulesOver(context.client)),
      Effect.provideService(StoreAdministration, {
        requestErasure,
      } as unknown as StoreAdministration["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        catalog,
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(ApplicationSettings, {
        snapshot: () => Effect.sync(() => ({ inbox: inboxSettings() })),
      } as unknown as ApplicationSettings["Service"]),
    );
    return { inbox, client: context.client };
  });
