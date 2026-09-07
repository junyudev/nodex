import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import type {
  WorkbenchRendererObservation,
  WorkbenchSceneReference,
} from "../../shared/nodex-app-tools/workbench";
import { WorkbenchAgentBridge, WorkbenchAgentBridgeError } from "./WorkbenchAgentBridge";
import { make, type WorkbenchObservationPrincipal } from "./WorkbenchObservation";

const principal: WorkbenchObservationPrincipal = {
  profileId: "profile",
  authorityFingerprint: "exact-frozen-turn",
  hostId: "local",
  backendGeneration: 1,
};
const reference: WorkbenchSceneReference = {
  windowSessionId: "window-A",
  rendererGeneration: "renderer-A",
  sceneOwner: { kind: "session", sessionId: "session" },
};
const observation: WorkbenchRendererObservation = {
  sceneOwner: reference.sceneOwner,
  selectedSceneOwner: reference.sceneOwner,
  presentationRevision: 3,
  mounted: true,
  focusedTarget: { tabId: "page-tab", panelId: "right", groupId: "right-group" },
  tabs: [
    {
      tabId: "page-tab",
      panelId: "right",
      groupId: "right-group",
      protected: false,
      persisted: true,
      preview: false,
      selected: true,
      visible: true,
      surface: {
        id: "page-tab",
        kind: "page_stage",
        titleSnapshot: "Original Page",
        config: { pageId: "page-A", accessContext: { kind: "library" } },
      },
      auxiliary: null,
    },
  ],
  groups: [
    {
      groupId: "right-group",
      panelId: "right",
      tabIds: ["page-tab"],
      selectedTabId: "page-tab",
      focused: true,
      visible: true,
    },
  ],
  panels: [
    {
      panelId: "right",
      collapsed: false,
      activeGroupId: "right-group",
      maximizedGroupId: null,
      size: {},
    },
    {
      panelId: "bottom",
      collapsed: true,
      activeGroupId: "bottom-group",
      maximizedGroupId: null,
      size: {},
    },
  ],
  splits: [],
};

const setup = (options: Parameters<typeof make>[0] = {}) =>
  Effect.gen(function* () {
    let current = structuredClone(observation);
    let generation = reference.rendererGeneration;
    let requests = 0;
    const owner = yield* make(options).pipe(
      Effect.provideService(WorkbenchAgentBridge, {
        request: (target: WorkbenchSceneReference) =>
          Effect.gen(function* () {
            requests += 1;
            if (target.rendererGeneration !== generation)
              return yield* new WorkbenchAgentBridgeError({ reason: "stale_renderer" });
            return { kind: "observe", observation: current } as const;
          }),
      } as unknown as WorkbenchAgentBridge["Service"]),
    );
    return {
      owner,
      change: (next: WorkbenchRendererObservation) => {
        current = next;
      },
      reload: () => {
        generation = "renderer-reloaded";
      },
      requests: () => requests,
    };
  });

it.effect("binds immutable observations to the exact caller, Profile, backend, and renderer", () =>
  Effect.gen(function* () {
    const subject = yield* setup();
    const captured = yield* subject.owner.capture(principal, reference);
    for (const different of [
      { ...principal, profileId: "other-profile" },
      { ...principal, authorityFingerprint: "other-turn" },
      { ...principal, hostId: "remote" },
      { ...principal, backendGeneration: 2 },
    ]) {
      assert.equal(
        (yield* subject.owner.resolve(different, captured.observationId).pipe(Effect.flip)).reason,
        "observation_unavailable",
      );
    }
    assert.equal(subject.requests(), 1);
    const returnedSurface = captured.observation.tabs[0]!.surface!;
    Object.assign(returnedSurface, { titleSnapshot: "Changed by consumer" });
    const resolved = yield* subject.owner.resolve(principal, captured.observationId);
    assert.equal(resolved.observation.tabs[0]!.surface!.titleSnapshot, "Original Page");
    subject.reload();
    assert.equal(
      (yield* subject.owner.resolve(principal, captured.observationId).pipe(Effect.flip)).reason,
      "stale_renderer",
    );
  }).pipe(Effect.scoped),
);

it.effect("rejects an old UI referent after a preview or Scene revision changes", () =>
  Effect.gen(function* () {
    const subject = yield* setup();
    const captured = yield* subject.owner.capture(principal, reference);
    subject.change({ ...observation, presentationRevision: 4, tabs: [] });
    assert.equal(
      (yield* subject.owner.resolve(principal, captured.observationId).pipe(Effect.flip)).reason,
      "stale_presentation",
    );
    assert.equal(
      (yield* subject.owner.resolve(principal, captured.observationId).pipe(Effect.flip)).reason,
      "observation_unavailable",
    );
  }).pipe(Effect.scoped),
);

it.effect("bounds retention by caller, total count, expiry, and complete encoded size", () =>
  Effect.gen(function* () {
    const subject = yield* setup({ maxPerCaller: 1, maxRecords: 2, lifetimeMs: 60_000 });
    const evicted = yield* subject.owner.capture(principal, reference);
    const retained = yield* subject.owner.capture(principal, reference);
    assert.equal(
      (yield* subject.owner.resolve(principal, evicted.observationId).pipe(Effect.flip)).reason,
      "observation_unavailable",
    );
    yield* subject.owner.capture({ ...principal, authorityFingerprint: "second-turn" }, reference);
    yield* subject.owner.capture({ ...principal, authorityFingerprint: "third-turn" }, reference);
    assert.equal(
      (yield* subject.owner.resolve(principal, retained.observationId).pipe(Effect.flip)).reason,
      "observation_unavailable",
    );
    const expiring = yield* subject.owner.capture(principal, reference);
    yield* TestClock.adjust(60_000);
    assert.equal(
      (yield* subject.owner.resolve(principal, expiring.observationId).pipe(Effect.flip)).reason,
      "observation_unavailable",
    );
    const small = yield* setup({ maxBytes: 1 });
    assert.equal(
      (yield* small.owner.capture(principal, reference).pipe(Effect.flip)).reason,
      "result_too_large",
    );
  }).pipe(Effect.scoped),
);
