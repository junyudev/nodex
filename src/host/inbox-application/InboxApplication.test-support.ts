import {
  inboxDispatchActionToCore,
  inboxPageBasisFromCore,
} from "../../main/core-client/inbox-adapter";
import { seedDecisionRun } from "../../../scripts/scenarios/seed/decision-run";
import type { InboxDispatchAction, InboxEntryKind } from "../../shared/inbox";
import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/board-dense";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { coreRuntimeError } from "../../main/core-runtime/CoreRuntimeError";
import { StoreAdministration } from "../../main/core-runtime/StoreAdministration";
import { make as makeInboxApplication } from "./InboxApplication";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
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

/** The machine a suggestion looks around on: only `directories` exist there. */
export const suggestionHostLayer = (directories: ReadonlySet<string> = new Set()) =>
  FileSystem.layerNoop({
    stat: (path) =>
      directories.has(path)
        ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
        : FileSystem.makeNoop({}).stat(path),
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
    database: {
      read: (read: Parameters<ScenarioClient["databaseRead"]>[0]) =>
        call("database.read", () => client.databaseRead(read)),
    },
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
  runtimeOverrides: Partial<AgentRuntimeApplication["Service"]> = {},
) =>
  Effect.gen(function* () {
    const { context } = yield* scenario;
    const core = coreModulesOver(context.client);
    const inbox = yield* makeInboxApplication.pipe(
      Effect.provideService(CoreModules, core),
      Effect.provideService(StoreAdministration, {
        requestErasure,
      } as unknown as StoreAdministration["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        catalog,
        runOutcome: () => Effect.succeed(null),
        ...runtimeOverrides,
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(ApplicationSettings, {
        snapshot: () => Effect.sync(() => ({ inbox: inboxSettings() })),
      } as unknown as ApplicationSettings["Service"]),
    );
    return {
      inbox,
      core,
      identity: context.runtime.identity,
      client: context.client,
      projectId: context.manifest.projectId,
    };
  });

/** Binds a test routing request to a fresh decision run, as the Host does before delivery. */
export const bindTestRouting = (
  { inbox, client }: { inbox: InboxApplication["Service"]; client: ScenarioClient },
  request: Effect.Success<ReturnType<InboxApplication["Service"]["suggestionRequests"]>>[number],
) =>
  Effect.gen(function* () {
    const sessionId = yield* Effect.promise(() =>
      seedDecisionRun(
        client,
        { kind: "routing", request_id: request.request_id, generation: request.generation },
        "Nodex · Routing test messages",
      ),
    );
    yield* inbox.beginRouting(request, sessionId);
    return sessionId;
  });

/** Seed advice through the same request and decision bindings as the Host. */
export const settleTestRouting = (
  { inbox, client }: { inbox: InboxApplication["Service"]; client: ScenarioClient },
  input: {
    readonly proposalId: string;
    readonly pageIds: readonly string[];
    readonly basis: readonly components["schemas"]["ProjectWorkspaceInboxPageBasis"][];
    readonly action: InboxDispatchAction;
    readonly kind: InboxEntryKind | null;
    readonly summary: string;
    readonly rationale: string | null;
    readonly producedBy: string;
  },
) =>
  Effect.gen(function* () {
    const requestId = createUuidV7();
    yield* inbox.requestSuggestion({
      requestId,
      pageIds: input.pageIds,
      mode: "auto",
      basis: input.basis.map(inboxPageBasisFromCore),
    });
    const request = yield* inbox.suggestionRequest(requestId);
    if (!request) return yield* Effect.die("Missing test routing request");
    const { generation } = request;
    const sessionId = yield* bindTestRouting({ inbox, client }, request);
    yield* inbox.settleSuggestion({
      request_id: requestId,
      generation,
      decision_session_id: sessionId,
      titles: [],
      suggestions: [
        {
          proposal_id: input.proposalId,
          page_ids: input.pageIds,
          action: inboxDispatchActionToCore(input.action),
          entry_kind: input.kind,
          summary: input.summary,
          rationale: input.rationale,
          explicit_request: false,
        },
      ],
      produced_by: input.producedBy,
    });
  });
