import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type {
  PresentationAnchor,
  WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { WorkbenchAgentBridge, WorkbenchAgentBridgeError } from "./WorkbenchAgentBridge";
import { make } from "./WorkbenchSceneSelection";

const windowA = { windowSessionId: "A", rendererGeneration: "A-1" };
const windowB = { windowSessionId: "B", rendererGeneration: "B-1" };
const project: WorkbenchSceneOwner = { kind: "project", projectId: "project" };
const session: WorkbenchSceneOwner = { kind: "session", sessionId: "session" };
const pages: WorkbenchSceneOwner = { kind: "pages" };
const anchor: PresentationAnchor = {
  ...windowA,
  sceneOwner: project,
  presentationRevision: 1,
  focusedTarget: null,
  selectedTabs: [],
  capturedAt: "2026-09-08T00:00:00.000Z",
};
const setup = (responses: ReadonlyMap<string, readonly WorkbenchSceneOwner[] | null>) =>
  make.pipe(
    Effect.provideService(WorkbenchAgentBridge, {
      registered: () =>
        [windowA, windowB].filter((reference) => responses.has(reference.windowSessionId)),
      request: (reference: WorkbenchWindowReference) => {
        const owners = responses.get(reference.windowSessionId);
        if (!owners) return Effect.fail(new WorkbenchAgentBridgeError({ reason: "unavailable" }));
        return Effect.succeed({
          kind: "discover",
          sceneOwners: owners,
          selectedSceneOwner: pages,
          presentationRevision: 2,
        });
      },
    } as unknown as WorkbenchAgentBridge["Service"]),
  );

it.effect("keeps a Project Dock anchor and refreshes only its submitting window", () =>
  Effect.gen(function* () {
    const select = yield* setup(
      new Map<string, readonly WorkbenchSceneOwner[] | null>([
        ["A", [project]],
        ["B", [session]],
      ]),
    );
    assert.deepStrictEqual(yield* select({ sessionId: "session", anchor, mode: "anchored" }), {
      status: "selected",
      reference: { ...windowA, sceneOwner: project },
    });
    assert.deepStrictEqual(yield* select({ sessionId: "session", anchor, mode: "refresh" }), {
      status: "selected",
      reference: { ...windowA, sceneOwner: pages },
    });
  }),
);

it.effect("reports window and Scene ambiguity without choosing global focus", () =>
  Effect.gen(function* () {
    const input = { sessionId: "session", anchor: null, mode: "anchored" as const };
    const multiWindow = yield* setup(
      new Map<string, readonly WorkbenchSceneOwner[] | null>([
        ["A", [session]],
        ["B", [session]],
      ]),
    );
    assert.strictEqual((yield* multiWindow(input)).status, "ambiguous_window");
    const multiScene = yield* setup(
      new Map<string, readonly WorkbenchSceneOwner[] | null>([["A", [session, project]]]),
    );
    assert.strictEqual((yield* multiScene(input)).status, "ambiguous_scene");
    const unique = yield* setup(new Map([["A", [session]]]));
    assert.deepStrictEqual(yield* unique(input), {
      status: "unavailable",
      candidates: [{ ...windowA, sceneOwner: session }],
    });
    const unavailable = yield* setup(
      new Map<string, readonly WorkbenchSceneOwner[] | null>([
        ["A", [session]],
        ["B", null],
      ]),
    );
    assert.strictEqual((yield* unavailable(input)).status, "unavailable");
  }),
);

it.effect("does not redirect a lost anchor to another available window", () =>
  Effect.gen(function* () {
    const select = yield* setup(
      new Map<string, readonly WorkbenchSceneOwner[] | null>([
        ["A", null],
        ["B", [session]],
      ]),
    );
    assert.deepStrictEqual(yield* select({ sessionId: "session", anchor, mode: "refresh" }), {
      status: "unavailable",
      candidates: [],
    });
  }),
);
