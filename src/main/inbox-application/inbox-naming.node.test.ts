import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { StoreAdministration } from "../core-runtime/StoreAdministration";
import { make as makeInboxApplication } from "./InboxApplication";

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

it.effect("names a provisional title only on the exact Page the Agent read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { context } = yield* scenario;
      const inbox = yield* makeInboxApplication.pipe(
        Effect.provideService(CoreModules, coreModulesOver(context.client)),
        Effect.provideService(StoreAdministration, {
          requestErasure: Effect.void,
        } as unknown as StoreAdministration["Service"]),
      );
      const message =
        "Homepage feels like a dev tool.\nMaybe it should read like a personal assistant?";
      const { pageId } = yield* inbox.send({ text: message });

      const [entry] = yield* inbox.pendingSuggestions(8);
      if (!entry) return assert.fail("Missing pending entry");
      assert.strictEqual(entry.body, message);
      assert.isTrue(entry.title_provisional);

      const named = yield* inbox.nameEntry({ basis: entry.basis, title: "Homepage positioning" });
      if (!named) return assert.fail("The untouched Page was not named");
      assert.isAbove(named.head_seq, entry.basis.head_seq);
      // A stale read never overwrites the Page.
      assert.isNull(yield* inbox.nameEntry({ basis: entry.basis, title: "Stale name" }));

      // The proposal is fenced by the named Page, so it stays confirmable.
      const proposalId = createUuidV7();
      yield* inbox.propose({
        proposalId,
        pageIds: [pageId],
        basis: [named],
        action: { type: "keep" },
        kind: "question",
        summary: "Keep this question for later.",
        rationale: null,
        producedBy: "Test",
      });
      const window = yield* inbox.window({ filter: "inbox" });
      assert.deepInclude(window.items[0], {
        pageId,
        title: "Homepage positioning",
        body: message,
      });
      assert.strictEqual(window.items[0]?.proposal?.proposalId, proposalId);
      assert.strictEqual(window.items[0]?.proposal?.state, "open");

      // Once named, the title belongs to the Page; a fresh suggestion pass may not rename it.
      yield* inbox.requestSuggestion({ pageIds: [pageId] });
      const [again] = yield* inbox.pendingSuggestions(8);
      assert.strictEqual(again?.page_id, pageId);
      assert.isFalse(again?.title_provisional);
    }),
  ),
);

it.effect("deleting a message erases it from both views and wakes Store maintenance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { context } = yield* scenario;
      let erasureRequests = 0;
      const inbox = yield* makeInboxApplication.pipe(
        Effect.provideService(CoreModules, coreModulesOver(context.client)),
        Effect.provideService(StoreAdministration, {
          requestErasure: Effect.sync(() => {
            erasureRequests += 1;
          }),
        } as unknown as StoreAdministration["Service"]),
      );
      const { pageId } = yield* inbox.send({ text: "Use the key sk-live-0123456789 for staging" });
      yield* inbox.delete({ pageIds: [pageId] });

      assert.deepEqual((yield* inbox.window({ filter: "inbox" })).items, []);
      assert.deepEqual((yield* inbox.window({ filter: "processed" })).items, []);
      assert.strictEqual((yield* inbox.summary).entryCount, 0);
      assert.strictEqual(erasureRequests, 1);
      // The Page is no longer readable anywhere in the Library.
      const page = yield* Effect.promise(() =>
        context.client
          .libraryRead({ kind: "page_projection_file", page_id: pageId, file_kind: "meta_yaml" })
          .then(
            () => "readable",
            () => "gone",
          ),
      );
      assert.strictEqual(page, "gone");
    }),
  ),
);
