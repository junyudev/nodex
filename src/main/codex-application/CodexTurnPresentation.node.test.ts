import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import {
  makeTestTurnPresentation,
  testSubmitPresentation,
} from "./CodexTurnPresentation.test-support";

const target = { kind: "thread", threadId: "thread-a" } as const;
const setup = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const presentation = yield* makeTestTurnPresentation.pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const ticket = yield* presentation.capture(11, { target, presentation: testSubmitPresentation });
  return { scope, presentation, ticket };
});

it.effect("stamps the submitting window and binds exact client identity before the response", () =>
  Effect.gen(function* () {
    const { scope, presentation, ticket } = yield* setup;
    assert.equal(
      (yield* presentation
        .capture(99, { target, presentation: testSubmitPresentation })
        .pipe(Effect.flip)).reason,
      "unavailable",
    );
    assert.equal(
      (yield* presentation
        .capture(22, { target, presentation: testSubmitPresentation })
        .pipe(Effect.flip)).reason,
      "stale_renderer",
    );
    assert.equal(
      (yield* presentation
        .claim(ticket, { kind: "thread", threadId: "other" }, "client-a")
        .pipe(Effect.flip)).reason,
      "target_mismatch",
    );
    const claim = yield* presentation.claim(ticket, target, "client-a");
    assert.equal(
      (yield* presentation.claim(ticket, target, "other-client").pipe(Effect.flip)).reason,
      "submission_mismatch",
    );
    const launch = yield* presentation.begin(claim, target.threadId);
    yield* presentation.observeUserMessage(target.threadId, "unrelated", null);
    yield* presentation.observeUserMessage(target.threadId, "unrelated", "other-client");
    assert.isNull(presentation.read(target.threadId, "unrelated"));
    yield* presentation.observeUserMessage(target.threadId, "accepted", "client-a");
    const anchor = presentation.read(target.threadId, "accepted");
    assert.deepInclude(anchor, { ...testSubmitPresentation, windowSessionId: "window-a" });
    yield* presentation.bind(launch, "accepted");
    assert.equal(
      (yield* presentation.claim(ticket, target, "client-a").pipe(Effect.flip)).reason,
      "already_accepted",
    );
    assert.equal(
      (yield* presentation.bind(launch, "other-turn").pipe(Effect.flip)).reason,
      "turn_mismatch",
    );
    presentation.finish(target.threadId, "accepted");
    assert.isNull(presentation.read(target.threadId, "accepted"));
    yield* presentation.bind(launch, "accepted");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("does not guess between concurrent submissions and permits proven-rejection retry", () =>
  Effect.gen(function* () {
    const { scope, presentation, ticket } = yield* setup;
    const claim = yield* presentation.claim(ticket, target, "client-a");
    const first = yield* presentation.begin(claim, target.threadId);
    assert.equal(
      (yield* presentation.begin(claim, target.threadId).pipe(Effect.flip)).reason,
      "in_flight",
    );
    const secondTicket = yield* presentation.capture(22, {
      target,
      presentation: { ...testSubmitPresentation, rendererGeneration: "renderer-b" },
    });
    const secondClaim = yield* presentation.claim(secondTicket, target, "client-a");
    const second = yield* presentation.begin(secondClaim, target.threadId);
    yield* presentation.observeUserMessage(target.threadId, "ambiguous", "client-a");
    assert.isNull(presentation.read(target.threadId, "ambiguous"));
    presentation.abort(first);
    presentation.releaseClaim(claim);
    yield* presentation.observeUserMessage(target.threadId, "accepted", "client-a");
    assert.equal(presentation.read(target.threadId, "accepted")?.windowSessionId, "window-b");
    const retryTicket = yield* presentation.capture(11, {
      target,
      presentation: testSubmitPresentation,
    });
    const retryClaim = yield* presentation.claim(retryTicket, target, "retry-client");
    const rejected = yield* presentation.begin(retryClaim, target.threadId);
    presentation.abort(rejected);
    const retry = yield* presentation.begin(retryClaim, target.threadId);
    yield* presentation.bind(retry, "retried");
    yield* presentation.bind(second, "accepted");
    yield* Scope.close(scope, Exit.void);
    assert.isNull(presentation.read(target.threadId, "retried"));
  }),
);

it.effect("retains queued origins across time and prunes only settled queue claims", () =>
  Effect.gen(function* () {
    const { scope, presentation, ticket } = yield* setup;
    const queued = yield* presentation.claim(ticket, target, "queued-client");
    presentation.retainQueued(queued);
    const ordinaryTicket = yield* presentation.capture(11, {
      target,
      presentation: testSubmitPresentation,
    });
    const ordinary = yield* presentation.claim(ordinaryTicket, target, "ordinary-client");
    const expired = yield* presentation.capture(11, {
      target,
      presentation: testSubmitPresentation,
    });
    yield* TestClock.adjust("16 minutes");
    assert.equal(
      (yield* presentation.claim(expired, target, "expired-client").pipe(Effect.flip)).reason,
      "expired",
    );
    assert.deepEqual(presentation.readQueued(target.threadId, "queued-client"), queued);
    assert.isUndefined(presentation.readQueued("other-thread", "queued-client"));
    presentation.reconcileQueued(target.threadId, []);
    assert.isUndefined(presentation.readQueued(target.threadId, "queued-client"));
    const launch = yield* presentation.begin(ordinary, target.threadId);
    yield* presentation.bind(launch, "ordinary-turn");
    assert.equal(presentation.read(target.threadId, "ordinary-turn")?.presentationRevision, 7);
    assert.isNull(yield* presentation.begin(undefined, "autonomous-thread"));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("binds a fresh Session submission to its materialized Conversation", () =>
  Effect.gen(function* () {
    const { scope, presentation } = yield* setup;
    const freshTarget = { kind: "session", sessionId: "session-a", launchId: "launch-a" } as const;
    const ticket = yield* presentation.capture(11, {
      target: freshTarget,
      presentation: testSubmitPresentation,
    });
    assert.equal(
      (yield* presentation
        .claim(ticket, { ...freshTarget, launchId: "other-launch" }, "fresh-client")
        .pipe(Effect.flip)).reason,
      "target_mismatch",
    );
    const claim = yield* presentation.claim(ticket, freshTarget, "fresh-client");
    const launch = yield* presentation.begin(claim, "new-thread");
    yield* presentation.bind(launch, "first-turn");
    assert.equal(presentation.read("new-thread", "first-turn")?.windowSessionId, "window-a");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "freezes selected Page identity even when its tab is reused or a reader mutates a snapshot",
  () =>
    Effect.gen(function* () {
      const { scope, presentation } = yield* setup;
      const selected = {
        tabId: "preview-page",
        panelId: "right" as const,
        groupId: "group-a",
        protected: false,
        persisted: false,
        preview: true,
        selected: true,
        visible: true,
        auxiliary: null,
        surface: {
          id: "preview-page",
          kind: "page_stage" as const,
          titleSnapshot: "Original page",
          config: {
            accessContext: { kind: "project" as const, projectId: "project-a" },
            pageId: "page-a",
          },
        },
      };
      const ticket = yield* presentation.capture(11, {
        target,
        presentation: {
          ...testSubmitPresentation,
          focusedTarget: null,
          selectedTabs: [selected],
        },
      });
      selected.surface.config.pageId = "replacement-page";
      const claim = yield* presentation.claim(ticket, target, "selected-client");
      const launch = yield* presentation.begin(claim, target.threadId);
      yield* presentation.bind(launch, "selected-turn");
      const anchor = presentation.read(target.threadId, "selected-turn");
      const surface = anchor?.selectedTabs[0]?.surface;
      if (surface?.kind !== "page_stage") throw new Error("Expected the original selected Page");
      assert.equal(surface.config.pageId, "page-a");
      Reflect.set(surface.config, "pageId", "reader-replacement");
      const reread = presentation.read(target.threadId, "selected-turn")?.selectedTabs[0]?.surface;
      assert.equal(reread?.kind === "page_stage" ? reread.config.pageId : null, "page-a");
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect(
  "bounds retained metadata bytes and releases capacity without evicting an accepted Turn",
  () =>
    Effect.gen(function* () {
      const { scope, presentation } = yield* setup;
      const metadata = (count: number) => ({
        ...testSubmitPresentation,
        selectedTabs: Array.from({ length: count }, (_, index) => ({
          tabId: `plan-${index}`,
          panelId: "right" as const,
          groupId: `group-${index}`,
          protected: false,
          persisted: false,
          preview: false,
          selected: true,
          visible: true,
          surface: null,
          auxiliary: { kind: "plan" as const, title: "x".repeat(1_900) },
        })),
      });
      const oversized = yield* presentation
        .capture(11, { target, presentation: metadata(400) })
        .pipe(Effect.flip);
      assert.equal(oversized.reason, "capacity");
      assert.include(oversized.message, "768 KiB");
      const snapshot = metadata(100);
      const tickets: { ticketId: string }[] = [];
      for (let index = 0; index < 200; index += 1) {
        const result = yield* presentation
          .capture(11, { target, presentation: snapshot })
          .pipe(Effect.result);
        if (result._tag === "Failure") {
          assert.equal(result.failure.reason, "capacity");
          assert.include(result.failure.message, "32 MiB");
          break;
        }
        tickets.push(result.success);
      }
      assert.isAbove(tickets.length, 1);
      assert.isBelow(tickets.length, 200);
      const acceptedClaim = yield* presentation.claim(tickets[0]!, target, "accepted-budget");
      const accepted = yield* presentation.begin(acceptedClaim, target.threadId);
      yield* presentation.bind(accepted, "accepted-budget-turn");
      assert.equal(
        (yield* presentation.capture(11, { target, presentation: snapshot }).pipe(Effect.flip))
          .reason,
        "capacity",
      );
      assert.isNotNull(presentation.read(target.threadId, "accepted-budget-turn"));
      const removed = yield* presentation.claim(tickets[1]!, target, "released-budget");
      presentation.releaseClaim(removed);
      yield* presentation.capture(11, { target, presentation: snapshot });
      presentation.finish(target.threadId, "accepted-budget-turn");
      yield* presentation.capture(11, { target, presentation: snapshot });
      yield* Scope.close(scope, Exit.void);
    }),
);
